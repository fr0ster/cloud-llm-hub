sap.ui.define([], function () {
  "use strict";

  return {
    /**
     * Convert basic markdown to HTML for sap.m.FormattedText.
     * Supports: headings, bold, italic, code blocks, inline code, lists, links.
     */
    markdownToHtml: function (text) {
      if (!text) { return ""; }

      function _escapeHtml(str) {
        return str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }

      // Split into completed code blocks and non-code segments
      var parts = [];
      var codeBlockRe = /```(\w*)\n([\s\S]*?)```/g;
      var lastIdx = 0;
      var match;
      while ((match = codeBlockRe.exec(text)) !== null) {
        if (match.index > lastIdx) {
          parts.push({ type: 'text', value: text.slice(lastIdx, match.index) });
        }
        parts.push({ type: 'code', value: match[2].trim() });
        lastIdx = match.index + match[0].length;
      }
      if (lastIdx < text.length) {
        var remainder = text.slice(lastIdx);
        var openFence = remainder.match(/```(\w*)\n([\s\S]*)$/);
        if (openFence) {
          if (openFence.index > 0) {
            parts.push({ type: 'text', value: remainder.slice(0, openFence.index) });
          }
          parts.push({ type: 'code', value: openFence[2] });
        } else {
          parts.push({ type: 'text', value: remainder });
        }
      }

      var html = '';
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (part.type === 'code') {
          html += '<pre style="background:#2d2d2d;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px"><code>' +
            _escapeHtml(part.value) + '</code></pre>';
        } else {
          var t = _escapeHtml(part.value);
          t = t.replace(/`([^`]+)`/g, function (_m, code) {
            return '<code style="background:#383838;padding:2px 4px;border-radius:3px;font-size:13px">' + code + '</code>';
          });
          t = t.replace(/^### (.+)$/gm, '<strong style="font-size:14px">$1</strong><br>');
          t = t.replace(/^## (.+)$/gm, '<strong style="font-size:15px">$1</strong><br>');
          t = t.replace(/^# (.+)$/gm, '<strong style="font-size:16px">$1</strong><br>');
          t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
          t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
          t = t.replace(/^[\-\*] (.+)$/gm, '&bull; $1<br>');
          t = t.replace(/^\d+\. (.+)$/gm, '&bull; $1<br>');
          t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
          t = t.replace(/\n\n/g, '<br><br>');
          t = t.replace(/\n/g, '<br>');
          html += t;
        }
      }
      return html;
    },

    /**
     * Escape HTML special characters.
     */
    escapeHtml: function (str) {
      if (!str) { return ""; }
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    },

    /**
     * Format tool call arguments as readable text.
     */
    formatToolArgs: function (args) {
      if (!args) { return ""; }
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch (e) {
          return args;
        }
      }
      return JSON.stringify(args, null, 2);
    }
  };
});
