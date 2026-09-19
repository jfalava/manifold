/* SPDX-License-Identifier: MIT */
/* Copyright © 2026 Jorge Fernando Álava. */
/* Modified by Manifold on 2026-09-05. See ATTRIBUTIONS.md. */

/** @effect-diagnostics asyncFunction:off */
/** @effect-diagnostics globalConsole:off */
import {
  ButtonRow,
  FlowSection,
  Form,
  FormConfirmationError,
  LabelRow,
  WebViewRow,
  type Cookie,
} from "@paperback/types";
import { COMIX_ORIGIN } from "@manifold/paperback-comix";
import { ManifoldTrackerSource, TrackerSettingsForm } from "../MANIFOLD/main.js";

class BetaTrackerSettingsForm extends TrackerSettingsForm {
  private betaUiStatus = "No beta UI action run yet.";
  private pendingConfirmation = false;

  override getSections() {
    // oxlint-disable-next-line typescript/no-this-alias -- Selector cannot resolve callback keys from polymorphic this
    const selectorTarget: BetaTrackerSettingsForm = this;
    return [
      ...super.getSections(),
      FlowSection(
        {
          id: "tracker-ios27-beta-ui",
          header: "iOS 27 beta UI",
          footer:
            "Unsafe UI compatibility probes for Paperback v0.9-r187. Use this section only on a test installation.",
        },
        [
          LabelRow("tracker-ios27-beta-ui-status", {
            title: "Probe status",
            value: this.betaUiStatus,
            style: "warning",
          }),
          ButtonRow("tracker-ios27-button-row", {
            title: "Test ButtonRow",
            onSelect: Application.Selector(selectorTarget, "buttonRowSelected"),
          }),
          ButtonRow("tracker-ios27-confirmation", {
            title: "Test confirmation dialog",
            onSelect: Application.Selector(selectorTarget, "confirmationRequested"),
          }),
          WebViewRow("tracker-ios27-web-view-row", {
            title: "Test WebViewRow",
            request: {
              url: `${COMIX_ORIGIN}/`,
              method: "GET",
              headers: {
                Accept: "text/html,application/xhtml+xml",
              },
            },
            onComplete: Application.Selector(selectorTarget, "webViewCompleted"),
            onCancel: Application.Selector(selectorTarget, "webViewCancelled"),
          }),
        ],
      ),
    ];
  }

  readonly buttonRowSelected = async (): Promise<void> => {
    this.betaUiStatus = "ButtonRow callback ran.";
    this.reloadForm();
  };

  readonly confirmationRequested = async (): Promise<void> => {
    this.pendingConfirmation = true;
    this.betaUiStatus = "Press Save to show the confirmation dialog.";
    this.reloadForm();
  };

  readonly confirmationAccepted = async (): Promise<void> => {
    this.betaUiStatus = "Confirmation dialog accepted.";
    this.reloadForm();
  };

  readonly webViewCompleted = async (cookies: Cookie[]): Promise<void> => {
    await this.comix.saveCloudflareBypassCookies(cookies);
    this.betaUiStatus = "WebViewRow completed.";
    this.reloadForm();
  };

  readonly webViewCancelled = async (): Promise<void> => {
    this.betaUiStatus = "WebViewRow cancelled.";
    this.reloadForm();
  };

  override formDidSubmit(): Promise<void> {
    if (this.pendingConfirmation) {
      this.pendingConfirmation = false;
      // oxlint-disable-next-line typescript/no-this-alias -- Selector requires the concrete beta form type
      const selectorTarget: BetaTrackerSettingsForm = this;
      throw new FormConfirmationError(
        Application.Selector(selectorTarget, "confirmationAccepted"),
        "This tests the Paperback confirmation dialog on iOS 27.",
      );
    }
    return super.formDidSubmit();
  }
}

export class ManifoldBetaExtension extends ManifoldTrackerSource {
  protected override createSettingsForm(): Form {
    return new BetaTrackerSettingsForm(this.comix);
  }
}

const MANIFOLD_BETA = new ManifoldBetaExtension();

// Paperback uses the source directory name as the extension ID. String-named
// exports let the beta ID retain the requested MANIFOLD-beta spelling.
export { MANIFOLD_BETA as "MANIFOLD-beta" };
