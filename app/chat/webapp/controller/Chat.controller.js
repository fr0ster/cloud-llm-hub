sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/m/MessageToast",
  "../util/StreamClient",
  "../model/formatter"
], function (Controller, MessageToast, StreamClient, formatter) {
  "use strict";

  /**
   * Chat controller — uses direct DOM (innerHTML) like the reference project.
   * sap.ui.core.HTML control wraps a plain div; we write into it directly.
   */
  return Controller.extend("cloud.llm.hub.chat.controller.Chat", {
    _abortStream: null,
    _messages: [],

    onInit: function () {
      console.log("[Chat] Controller v2 initialized");
      var that = this;
      StreamClient.getModels()
        .then(function (data) {
          var oModel = that.getView().getModel();
          if (oModel && data.data && data.data.length > 0) {
            oModel.setProperty("/modelName", data.data[0].id);
          }
        })
        .catch(function () {
          var oModel = that.getView().getModel();
          if (oModel) { oModel.setProperty("/modelName", "unavailable"); }
        });
    },

    _getChatWindow: function () {
      return document.getElementById("chat-window");
    },

    onSendMessage: function () {
      console.log("[Chat] onSendMessage called");
      var oModel = this.getView().getModel();
      var sValue = (oModel.getProperty("/inputValue") || "").trim();
      if (!sValue || oModel.getProperty("/busy")) { return; }

      this._messages.push({ role: "user", content: sValue, type: "user" });
      this._messages.push({ role: "assistant", content: "", type: "assistant", toolCalls: [], usage: null });

      oModel.setProperty("/inputValue", "");
      oModel.setProperty("/busy", true);
      oModel.setProperty("/statusText", "PROCESSING");

      this._renderChat();
      this._scrollToBottom();

      var apiMessages = [];
      for (var i = 0; i < this._messages.length; i++) {
        var m = this._messages[i];
        if (m.role === "user" || (m.role === "assistant" && m.content)) {
          apiMessages.push({ role: m.role, content: m.content });
        }
      }

      var that = this;
      var assistantIdx = this._messages.length - 1;
      var errorOccurred = false;

      this._abortStream = StreamClient.streamChat({
        messages: apiMessages,

        onDelta: function (content) {
          that._messages[assistantIdx].content += content;
          oModel.setProperty("/statusText", "STREAMING");
          that._renderChat();
          that._scrollToBottom();
        },

        onToolCall: function (toolCalls) {
          oModel.setProperty("/statusText", "TOOL CALL");
          var existing = that._messages[assistantIdx].toolCalls || [];
          for (var i = 0; i < toolCalls.length; i++) {
            var tc = toolCalls[i];
            var idx = tc.index != null ? tc.index : existing.length;
            if (!existing[idx]) { existing[idx] = { name: "", arguments: "" }; }
            if (tc.function) {
              if (tc.function.name) { existing[idx].name += tc.function.name; }
              if (tc.function.arguments) { existing[idx].arguments += tc.function.arguments; }
            }
          }
          that._messages[assistantIdx].toolCalls = existing;
        },

        onUsage: function (usage) {
          that._messages[assistantIdx].usage = usage;
        },

        onDone: function () {
          if (errorOccurred) { return; }
          oModel.setProperty("/busy", false);
          oModel.setProperty("/statusText", "IDLE");
          that._abortStream = null;
          that._renderChat();
          that._scrollToBottom();
          var oInput = that.byId("chatInput");
          if (oInput) { oInput.focus(); }
        },

        onError: function (err) {
          errorOccurred = true;
          oModel.setProperty("/busy", false);
          oModel.setProperty("/statusText", "ERROR");
          that._abortStream = null;
          that._messages[assistantIdx].content = "Error: " + (err.message || String(err));
          that._messages[assistantIdx].type = "error";
          that._renderChat();
          that._scrollToBottom();
          MessageToast.show("Request failed: " + (err.message || String(err)));
        }
      });
    },

    onClearHistory: function () {
      var oModel = this.getView().getModel();
      this._messages = [];
      oModel.setProperty("/statusText", "IDLE");
      if (this._abortStream) {
        this._abortStream();
        this._abortStream = null;
        oModel.setProperty("/busy", false);
      }
      this._renderChat();
    },

    /**
     * Render entire chat via innerHTML — exactly like reference project.
     */
    _renderChat: function () {
      var el = this._getChatWindow();
      if (!el) { console.warn("[Chat] chat-window element not found"); return; }

      var html = "";
      for (var i = 0; i < this._messages.length; i++) {
        html += this._renderMessage(this._messages[i]);
      }
      el.innerHTML = html || '<div style="color:#888;padding:20px">Send a message to start chatting.</div>';
    },

    _renderMessage: function (msg) {
      if (msg.type === "user") {
        return '<div style="text-align:right;margin:0 0 16px">' +
          '<div style="display:inline-block;max-width:75%;text-align:left;background:#0854A0;color:#fff;padding:10px 16px;border-radius:16px 16px 4px 16px;word-wrap:break-word;white-space:pre-wrap">' +
          formatter.escapeHtml(msg.content) +
          '</div></div>';
      }

      if (msg.type === "error") {
        return '<div style="margin:0 0 16px">' +
          '<div style="display:inline-block;max-width:75%;background:#3b1010;color:#ff5e5e;padding:10px 16px;border-radius:16px 16px 16px 4px;border-left:3px solid #ff5e5e;word-wrap:break-word">' +
          formatter.escapeHtml(msg.content) +
          '</div></div>';
      }

      // Assistant
      var content = "";
      if (!msg.content) {
        content = '<span style="color:#888;font-style:italic">Agent is processing...</span>';
      } else {
        content = formatter.markdownToHtml(msg.content);
      }

      var toolsHtml = "";
      if (msg.toolCalls && msg.toolCalls.length) {
        for (var t = 0; t < msg.toolCalls.length; t++) {
          var tc = msg.toolCalls[t];
          if (!tc.name) { continue; }
          var argsStr = tc.arguments || "{}";
          try { argsStr = JSON.stringify(JSON.parse(argsStr), null, 2); } catch (e) { /* keep */ }
          toolsHtml += '<div style="margin-top:8px;background:#0c0c0c;border:1px solid #333;border-left:3px solid #ffcc00;padding:8px 12px;border-radius:2px">' +
            '<div style="font-size:11px;font-weight:bold;color:#ffcc00;text-transform:uppercase">Tool: ' + formatter.escapeHtml(tc.name) + '</div>' +
            '<pre style="margin:4px 0 0;font-size:11px;color:#aaa;white-space:pre-wrap;word-wrap:break-word">' + formatter.escapeHtml(argsStr) + '</pre>' +
            '</div>';
        }
      }

      var usageHtml = "";
      if (msg.usage) {
        var total = (msg.usage.prompt_tokens || 0) + (msg.usage.completion_tokens || 0);
        usageHtml = '<div style="margin-top:8px;font-size:11px;color:#666">' +
          'Tokens: ' + (msg.usage.prompt_tokens || 0) + ' in / ' +
          (msg.usage.completion_tokens || 0) + ' out / ' + total + ' total</div>';
      }

      return '<div style="margin:0 0 16px">' +
        '<div style="display:inline-block;max-width:75%;background:#1c1c1c;padding:12px 16px;border-radius:16px 16px 16px 4px;box-shadow:0 1px 2px rgba(0,0,0,0.3);word-wrap:break-word;color:#e0e0e0;font-size:14px;line-height:1.6">' +
        content + toolsHtml + usageHtml +
        '</div></div>';
    },

    _scrollToBottom: function () {
      var that = this;
      setTimeout(function () {
        var oScroll = that.byId("chatScroll");
        if (oScroll) {
          var oDom = oScroll.getDomRef();
          if (oDom) { oDom.scrollTop = oDom.scrollHeight; }
        }
      }, 50);
    }
  });
});
