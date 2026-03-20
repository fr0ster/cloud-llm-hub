sap.ui.define([], function () {
  "use strict";

  /**
   * SSE streaming client for OpenAI-compatible /v1/chat/completions endpoint.
   * Modeled after the reference llm_agent index.html fetch+pump pattern.
   */
  return {
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

      var url = this._getBaseUrl() + "/v1/chat/completions";

      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: options.messages,
          stream: true,
          stream_options: { include_usage: true }
        }),
        signal: controller.signal
      })
        .then(function (response) {
          if (!response.ok) {
            return response.text().then(function (text) {
              throw new Error("HTTP " + response.status + ": " + text);
            });
          }
          return that._pump(response.body.getReader(), options);
        })
        .catch(function (err) {
          if (err.name === "AbortError") { return; }
          if (options.onError) { options.onError(err); }
        });

      return function () { controller.abort(); };
    },

    /**
     * Recursive pump — reads stream chunks one by one.
     * Same pattern as reference project's pump() function.
     */
    _pump: function (reader, options) {
      var decoder = new TextDecoder();
      var buffer = "";
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
          var parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (var i = 0; i < parts.length; i++) {
            if (done) { break; }
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
      var lines = text.split("\n");
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === ":") { continue; }
        if (line === "data: [DONE]") { return; }
        if (line.indexOf("data: ") === 0) {
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

      if (!data.choices || !data.choices.length) { return; }

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
      var url = this._getBaseUrl() + "/v1/chat/completions";

      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages, stream: false })
      }).then(function (response) {
        if (!response.ok) {
          return response.text().then(function (text) {
            throw new Error("HTTP " + response.status + ": " + text);
          });
        }
        return response.json();
      });
    },

    /**
     * Fetch available models.
     */
    getModels: function () {
      var url = this._getBaseUrl() + "/v1/models";
      return fetch(url).then(function (r) { return r.json(); });
    },

    /**
     * Base URL for API calls (empty = same origin).
     */
    _getBaseUrl: function () {
      return "";
    }
  };
});
