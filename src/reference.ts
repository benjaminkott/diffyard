/** Served as an MCP resource so an agent can look up the step vocabulary. */
export const STEP_REFERENCE = `# diffyard interaction steps

Steps run in order after the page has loaded and before the screenshot is taken.
Each step is a mapping with exactly one action key.

## Clicking and typing

    - click: "button.nav-toggle"
    - dblclick: ".card"
    - hover: ".menu-item"
    - focus: "input[name=q]"
    - fill: { selector: "input[name=q]", value: "typo3" }
    - press: { selector: "input[name=q]", key: "Enter" }
    - press: { key: "Escape" }                 # without a selector: the page
    - select: { selector: "#lang", value: "de" }
    - check: "#terms"
    - uncheck: "#newsletter"

## Waiting

    - waitFor: ".nav--open"                    # until visible
    - waitForHidden: ".loading-spinner"
    - waitForText: { selector: ".status", text: "Done" }
    - waitForTimeout: 400                      # milliseconds, use sparingly
    - waitForUrl: "**/checkout/success"
    - waitForLoadState: networkidle            # load | domcontentloaded | networkidle

## Scrolling and navigation

    - scrollTo: "#footer"
    - scrollToBottom: true
    - scrollToTop: true
    - scrollBy: 400
    - goto: "/another-page"

## Escape hatches

    - evaluate: "document.body.classList.add('debug')"
    - addStyle: ".ad-slot { display: none }"
    - setViewport: { width: 1280, height: 720 }

## Modifiers

Every step also accepts:

    - click: ".cookie-banner__close"
      timeout: 3000        # override the global timeout for this step
      optional: true       # do not fail the scenario if the step cannot run

\`optional\` is for elements that may or may not be there — a banner that only
appears for some visitors. It is not a fix for a click that fails because
something covers it; that needs the covering element accepted or removed.

## Where steps can live

- \`beforeEach\` — on every page of both sides, before the scenario's own steps
- \`compare.a.steps\` / \`compare.b.steps\` — only on that side, e.g. dismissing a
  staging notice that exists on one system only
- \`scenarios[].steps\` — for that scenario

## Making a state comparable

A scenario that opens something usually wants \`fullPage: false\`, because the
opened menu lives in the viewport and the rest of the page only adds noise.

The DOM is serialised at screenshot time, so the markup diff covers the opened
state too — not the state the page loaded in.
`;
