sap.ui.define([], function () {
  'use strict';

  /**
   * SSE streaming client for OpenAI-compatible /v1/chat/completions endpoint.
   * Modeled after the reference llm_agent index.html fetch+pump pattern.
   */
  return {
    _sessionOpening: null,

    subscribeEvents: function (options) {
      var that = this;
      var stopped = false;
      var delay = 1000;
      var timer;
      var controller;
      var reader;
      var lastId;
      var rendered = new Set();
      function connect() {
        if (stopped) {
          return;
        }
        controller = new AbortController();
        that
          ._sessionFetch(that._getBaseUrl() + '/v1/session/events', {
            method: 'GET',
            headers: Object.assign(
              { Accept: 'text/event-stream' },
              lastId ? { 'Last-Event-ID': lastId } : {},
            ),
            signal: controller.signal,
          })
          .then(async function (response) {
            if (stopped) {
              return;
            }
            // The default adaptive coordinator has no event channel.
            if (response.status === 409) {
              stopped = true;
              return;
            }
            if (!response.ok) {
              throw new Error('HTTP ' + response.status);
            }
            reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            try {
              while (!stopped) {
                var chunk = await reader.read();
                if (chunk.done) {
                  break;
                }
                delay = 1000;
                buffer += decoder.decode(chunk.value, { stream: true });
                var boundary;
                while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
                  var frame = buffer.slice(0, boundary.index);
                  buffer = buffer.slice(boundary.index + boundary[0].length);
                  var event = 'message';
                  var data = [];
                  var id;
                  frame.split(/\r?\n/).forEach(function (line) {
                    if (line.indexOf('id:') === 0) {
                      id = line.slice(3).trim();
                    }
                    if (line.indexOf('event:') === 0) {
                      event = line.slice(6).trim();
                    }
                    if (line.indexOf('data:') === 0) {
                      data.push(line.slice(5).trimStart());
                    }
                  });
                  if (!data.length || stopped) {
                    continue;
                  }
                  var parsed;
                  try {
                    parsed = JSON.parse(data.join('\n'));
                  } catch (e) {
                    continue;
                  }
                  if (event === 'message' && options.onMessage) {
                    id = id || parsed.id;
                    if (!rendered.has(id)) {
                      await options.onMessage(parsed);
                      rendered.add(id);
                    }
                    lastId = id;
                    that
                      ._sessionFetch(
                        that._getBaseUrl() + '/v1/session/events/ack',
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ id: id }),
                        },
                      )
                      .catch(function () {});
                  }
                  if (event === 'tasks' && options.onTasks) {
                    options.onTasks(parsed);
                  }
                  if (event === 'task' && options.onTask) {
                    options.onTask(parsed);
                  }
                }
              }
            } finally {
              reader.releaseLock();
              reader = null;
            }
          })
          .catch(function (err) {
            if (!stopped && options.onError) {
              options.onError(err);
            }
          })
          .finally(function () {
            if (!stopped) {
              timer = setTimeout(connect, delay);
              delay = Math.min(delay * 2, 30000);
            }
          });
      }
      connect();
      return function () {
        stopped = true;
        clearTimeout(timer);
        if (controller) {
          controller.abort();
        }
        if (reader) {
          reader.cancel().catch(function () {});
        }
      };
    },

    _ensureSession: function () {
      var that = this;
      if (this._sessionOpening) {
        return this._sessionOpening;
      }
      if (localStorage.getItem('clh.session')) {
        return Promise.resolve();
      }
      this._sessionOpening = fetch(this._getBaseUrl() + '/v1/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-clh-session': '' },
        body: JSON.stringify({}),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) {
              throw new Error(
                (data.error && data.error.message) || 'HTTP ' + response.status,
              );
            }
            localStorage.setItem('clh.session', data.session);
          });
        })
        .finally(function () {
          that._sessionOpening = null;
        });
      return this._sessionOpening;
    },

    closeSession: function () {
      var that = this;
      return Promise.resolve(this._sessionOpening)
        .then(function () {
          return fetch(that._getBaseUrl() + '/v1/session', {
            method: 'DELETE',
            headers: {
              'x-clh-session': localStorage.getItem('clh.session') || '',
            },
          });
        })
        .then(function (response) {
          if (!response.ok && response.status !== 404) {
            throw new Error('HTTP ' + response.status);
          }
          localStorage.removeItem('clh.session');
          return that._ensureSession();
        });
    },

    _sessionFetch: function (url, options) {
      var that = this;
      return this._ensureSession().then(function () {
        var key = localStorage.getItem('clh.session');
        function request() {
          return fetch(
            url,
            Object.assign({}, options, {
              headers: Object.assign({}, options.headers, {
                'x-clh-session': localStorage.getItem('clh.session'),
              }),
            }),
          );
        }
        return request().then(function (response) {
          if (response.status !== 404) {
            return response;
          }
          return response
            .clone()
            .json()
            .catch(function () {
              return null;
            })
            .then(function (data) {
              if (
                !data ||
                !data.error ||
                data.error.code !== 'SESSION_NOT_FOUND'
              ) {
                return response;
              }
              if (localStorage.getItem('clh.session') === key) {
                localStorage.removeItem('clh.session');
              }
              return that._ensureSession().then(request);
            });
        });
      });
    },
    /**
     * Stream a chat completion request.
     *
     * @param {object} options
     * @param {Array} options.messages - OpenAI-format messages array
     * @param {function} options.onDelta - Called with content text chunks
     * @param {function} options.onToolCall - Called with tool_calls delta array
     * @param {function} options.onUsage - Called with usage object
     * @param {function} options.onDone - Called when stream completes
     * @param {function} options.onError - Called with Error object
     * @returns {function} abort - Call to cancel the stream
     */
    streamChat: function (options) {
      var controller = new AbortController();
      var that = this;

      var url = this._getBaseUrl() + '/v1/chat/completions';
      var headers = { 'Content-Type': 'application/json' };

      this._sessionFetch(url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({
          messages: options.messages,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      })
        .then(function (response) {
          if (!response.ok) {
            return response.text().then(function (text) {
              throw new Error('HTTP ' + response.status + ': ' + text);
            });
          }
          return that._pump(response.body.getReader(), options);
        })
        .catch(function (err) {
          if (err.name === 'AbortError') {
            return;
          }
          if (options.onError) {
            options.onError(err);
          }
        });

      return function () {
        controller.abort();
      };
    },

    /**
     * Recursive pump — reads stream chunks one by one.
     * Same pattern as reference project's pump() function.
     */
    _pump: function (reader, options) {
      var decoder = new TextDecoder();
      var buffer = '';
      var that = this;
      var done = false;

      function pump() {
        return reader.read().then(function (result) {
          if (result.done) {
            // Process any remaining buffer
            if (buffer.trim()) {
              that._processSSE(buffer, options);
            }
            if (!done && options.onDone) {
              done = true;
              options.onDone();
            }
            return;
          }

          buffer += decoder.decode(result.value, { stream: true });

          // Split on double newline (SSE event boundary)
          var parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (var i = 0; i < parts.length; i++) {
            if (done) {
              break;
            }
            that._processSSE(parts[i], options);
          }

          if (!done) {
            return pump();
          }
        });
      }

      return pump();
    },

    /**
     * Process a single SSE event block.
     */
    _processSSE: function (text, options) {
      var lines = text.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (line.indexOf(': status ') === 0) {
          try {
            var status = JSON.parse(line.substring(9));
            if (options.onStatus) {
              options.onStatus(status);
            }
          } catch (e) {
            /* malformed status JSON */
          }
          continue;
        }
        if (!line || line.charAt(0) === ':') {
          continue;
        }
        if (line === 'data: [DONE]') {
          return;
        }
        if (line.indexOf('data: ') === 0) {
          try {
            var data = JSON.parse(line.substring(6));
            this._handleChunk(data, options);
          } catch (e) {
            // malformed JSON — skip
          }
        }
      }
    },

    /**
     * Handle a parsed SSE data chunk.
     */
    _handleChunk: function (data, options) {
      // Server error chunk
      if (data.error && data.error.message) {
        if (options.onError) {
          options.onError(new Error(data.error.message));
        }
        return;
      }

      // Usage (standalone or in chunk)
      if (data.usage && options.onUsage) {
        options.onUsage(data.usage);
      }

      if (!data.choices || !data.choices.length) {
        return;
      }

      var choice = data.choices[0];
      var delta = choice.delta || {};

      // Text content
      if (delta.content && options.onDelta) {
        options.onDelta(delta.content);
      }

      // Tool calls
      if (delta.tool_calls && delta.tool_calls.length && options.onToolCall) {
        options.onToolCall(delta.tool_calls);
      }
    },

    /**
     * Non-streaming chat request.
     */
    chat: function (messages) {
      var url = this._getBaseUrl() + '/v1/chat/completions';

      return this._sessionFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: messages, stream: false }),
      }).then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            throw new Error('HTTP ' + response.status + ': ' + text);
          });
        }
        return response.json();
      });
    },

    /**
     * Fetch available models.
     */
    getModels: function () {
      var url = this._getBaseUrl() + '/v1/models';
      return fetch(url).then(function (r) {
        return r.json();
      });
    },

    /**
     * Base URL for API calls (empty = same origin).
     */
    _getBaseUrl: function () {
      return '';
    },
  };
});
