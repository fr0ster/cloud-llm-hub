sap.ui.define(
  [
    'sap/ui/core/mvc/ControllerExtension',
    'sap/ui/model/json/JSONModel',
    'sap/ui/core/Element',
  ],
  (ControllerExtension, JSONModel, Element) => {
    return ControllerExtension.extend('monitor.ext.controller.FrameSource', {
      override: {
        onInit: function () {
          const oModel = new JSONModel({ busy: false, source: '', error: '' });
          this.base.getView().setModel(oModel, 'frame');
          this._reqToken = 0;
          this._wireFrameSelect();
        },
        onPageReady: function () {
          // Each navigation rebinds the page. Bump _reqToken FIRST so any
          // in-flight request from the previous dump becomes stale and is
          // discarded by its then/catch — otherwise a slow response could
          // write the old dump's source into the new page.
          this._reqToken += 1;
          const oModel = this.base.getView().getModel('frame');
          if (oModel) {
            oModel.setProperty('/source', '');
            oModel.setProperty('/error', '');
            oModel.setProperty('/busy', false);
          }
          const oCombo = this._findComboBox();
          if (oCombo) oCombo.setSelectedKey('');
          // Re-attempt to wire — covers the case where the section was
          // collapsed during the first navigation and only renders later.
          this._wireFrameSelect();
        },
        onExit: function () {
          // View teardown — ensure the polling interval doesn't outlive the
          // controller and attach a stale handler to a ComboBox from a
          // different ObjectPage instance later.
          if (this._wireTimer) {
            clearInterval(this._wireTimer);
            this._wireTimer = undefined;
          }
        },
      },

      // FE V4 1.136 silently drops XMLFragment event-handler bindings for
      // ControllerExtension methods regardless of namespace prefix
      // (`.handler`, `.extension.<name>.handler`, fully-qualified path —
      // none reach the method). We attach selectionChange imperatively
      // once the ComboBox is in the Element registry. Polling has no
      // upper time bound — sections may render lazily on first scroll —
      // and stops once attachment succeeds. The interval is kept by the
      // controller, so it dies with the view.
      _wireFrameSelect: function () {
        if (this._wireTimer) return;
        const tick = () => {
          const oCombo = this._findComboBox();
          if (oCombo && !oCombo.data('frameSourceWired')) {
            oCombo.data('frameSourceWired', true);
            oCombo.attachSelectionChange(
              this._onFrameSelectionChange.bind(this),
            );
          }
          if (oCombo) {
            clearInterval(this._wireTimer);
            this._wireTimer = undefined;
          }
        };
        tick();
        if (!this._wireTimer && !this._findComboBox()) {
          this._wireTimer = setInterval(tick, 500);
        }
      },

      _findComboBox() {
        // Scope by current view ID so we don't pick up a frameSelect from
        // a different ObjectPage instance — Element.registry is global and
        // long-lived sections can co-exist during navigation transitions.
        const sViewId = this.base.getView().getId();
        const aMatches = Element.registry.filter(
          (oEl) =>
            oEl.getId().startsWith(sViewId) &&
            oEl.getId().includes('frameSelect') &&
            oEl.getMetadata().getName() === 'sap.m.ComboBox',
        );
        return aMatches[0];
      },

      _onFrameSelectionChange(oEvent) {
        const oItem = oEvent.getParameter('selectedItem');
        if (!oItem) return;
        const iPosition = parseInt(oItem.getKey(), 10);
        if (Number.isNaN(iPosition)) return;

        const sDumpID = this.base
          .getExtensionAPI()
          .getBindingContext()
          ?.getProperty('ID');
        if (!sDumpID) return;

        const oModel = this.base.getView().getModel('frame');
        oModel.setProperty('/error', '');
        oModel.setProperty('/source', '');
        oModel.setProperty('/busy', true);

        // Stale-request guard: each call gets a monotonically-increasing
        // token. then/catch only commit results if their token still matches
        // the latest issued one — otherwise a slow response for an earlier
        // selection would clobber a fresher one.
        this._reqToken += 1;
        const iToken = this._reqToken;

        const oOData = this.base.getExtensionAPI().getModel();
        const sPath = `/GetFrameSource(dumpID=${sDumpID},position=${iPosition})`;
        oOData
          .bindContext(sPath)
          .requestObject()
          .then((oResp) => {
            if (iToken !== this._reqToken) return;
            const sSrc =
              (oResp && (oResp.value !== undefined ? oResp.value : oResp)) ||
              '';
            oModel.setProperty('/source', sSrc);
            oModel.setProperty('/busy', false);
          })
          .catch((oErr) => {
            if (iToken !== this._reqToken) return;
            const sMsg =
              oErr?.error?.message || oErr?.message || 'Source fetch failed';
            oModel.setProperty('/error', sMsg);
            oModel.setProperty('/busy', false);
          });
      },
    });
  },
);
