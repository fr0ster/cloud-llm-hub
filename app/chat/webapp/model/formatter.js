sap.ui.define([], function () {
  "use strict";

  return {
    /**
     * Convert basic markdown to HTML for sap.m.FormattedText.
     * Supports: headings, bold, italic, code blocks, inline code, lists, links.
     */
    markdownToHtml: function (text) {
      if (!text) { return ""; }

      var html = text;

      // Code blocks (``` ... ```)
      html = html.replace(/```(\w*)\n([\s\S]*?)```/g, function (_match, _lang, code) {
        return '<pre style="background:#2d2d2d;padding:12px;border-radius:4px;overflow-x:auto;font-size:13px"><code>' +
          _escapeHtml(code.trim()) + '</code></pre>';
      });

      // Inline code (`...`)
      html = html.replace(/`([^`]+)`/g, function (_match, code) {
        return '<code style="background:#383838;padding:2px 4px;border-radius:3px;font-size:13px">' +
          _escapeHtml(code) + '</code>';
      });

      // Headings (### > ## > #)
      html = html.replace(/^### (.+)$/gm, '<strong style="font-size:14px">$1</strong><br>');
      html = html.replace(/^## (.+)$/gm, '<strong style="font-size:15px">$1</strong><br>');
      html = html.replace(/^# (.+)$/gm, '<strong style="font-size:16px">$1</strong><br>');

      // Bold (**text**)
      html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

      // Italic (*text*)
      html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

      // Unordered lists (- item or * item)
      html = html.replace(/^[\-\*] (.+)$/gm, '&bull; $1<br>');

      // Ordered lists (1. item)
      html = html.replace(/^\d+\. (.+)$/gm, '&bull; $1<br>');

      // Links [text](url)
      html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

      // Line breaks (double newline = paragraph)
      html = html.replace(/\n\n/g, '<br><br>');
      html = html.replace(/\n/g, '<br>');

      return html;

      function _escapeHtml(str) {
        return str
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;");
      }
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
