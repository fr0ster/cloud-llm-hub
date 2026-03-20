sap.ui.define([
  "sap/ui/core/UIComponent",
  "sap/ui/model/json/JSONModel"
], function (UIComponent, JSONModel) {
  "use strict";

  return UIComponent.extend("cloud.llm.hub.chat.Component", {
    metadata: {
      manifest: "json"
    },

    init: function () {
      UIComponent.prototype.init.apply(this, arguments);

      var oModel = new JSONModel({
        messages: [],
        inputValue: "",
        busy: false,
        modelName: "loading...",
        statusText: "IDLE"
      });
      this.setModel(oModel);
    }
  });
});
