/**
 * Template written by `diffyard init`, doubling as the documented reference.
 */
export const EXAMPLE_CONFIG = `# yaml-language-server: $schema=./diffyard.schema.json
# diffyard — compares two URLs against each other, scenario by scenario.
# The schema on the first line makes your editor validate and complete this
# file; run \`diffyard schema\` to write it again. To keep no copy at all, point
# that line at the published schema instead — \`diffyard schema\` prints it.

compare:
  # Short form: just the URL.
  a: https://example.ddev.site
  # Long form: everything a protected environment needs.
  b:
    url: https://example.com
    label: live             # shown in the report and the CLI instead of "B"
    # basicAuth: { username: staging, password: secret }
    # headers:
    #   X-Preview-Token: abc123
    # cookies:
    #   - { name: staging-access, value: "1", domain: example.com }
    # storageState: ./auth.json   # a Playwright storage state file

output:
  # Relative to where you run diffyard, not to this file: the results belong to
  # the project being checked, even when the config is kept somewhere central.
  # diffyard puts a .gitignore inside, so runs never end up in a commit.
  dir: .diffyard-report
  # Each run gets its own folder inside dir, named after the start time plus a
  # short hash so two runs in the same second cannot collide. A \`latest\`
  # symlink always points at the most recent one.
  runFolder: true
  # runId: nightly        # fixed folder name instead of the generated one
  title: Relaunch comparison

browser:
  engine: chromium        # chromium | firefox | webkit
  headless: true
  # Declared once, referenced by name from the scenarios.
  viewports:
    mobile:  { width: 375, height: 812 }
    tablet:  { width: 768, height: 1024 }
    desktop: { width: 1440, height: 900 }
    # retina: { width: 1440, height: 900, dpr: 2 }
  colorScheme: light      # light | dark | no-preference
  reducedMotion: true
  # locale: de-DE
  # timezone: Europe/Berlin
  # ignoreHTTPSErrors: true   # needed for local self-signed certificates

timeouts:
  action: 30000           # per Playwright action
  comparison: 180000      # hard limit for one scenario/viewport pair
  run: 0                  # hard limit for the whole run, 0 = none

diff:
  # Share of differing pixels a comparison may have and still pass.
  threshold: 0.001        # 0.1 %
  # Per-pixel colour tolerance. Higher is more forgiving.
  pixelThreshold: 0.1
  ignoreAntialiasing: true
  # Match rows up before comparing. Without it a page that moved down by
  # fourteen pixels differs in every row below the shift, and a change nobody
  # would notice is reported as 46 %. The positional number is still recorded.
  alignRows: true
  # Applied to every scenario, merged with the scenario's own lists.
  # \`remove\` and \`hide\` run twice: right after loading, so overlays cannot
  # swallow the clicks of your steps, and again just before the screenshot.
  mask: []                # painted over
  hide: []                # visibility: hidden
  remove: []              # dropped from the DOM

stability:
  freeze: true            # stop animations, transitions and the text caret
  triggerLazyLoad: true   # scroll once so lazy images load before the shot
  retries: 1              # retry a failed capture
  # How many comparisons run at once. Faster, and less deterministic: browsers
  # competing for the machine render at slightly different moments, which pages
  # sensitive to animation or timing can pick up. Raise it for a large suite of
  # static pages, leave it at 1 when a difference has to be beyond doubt.
  workers: 1

# Runs on every page of both sides, before the scenario's own steps.
# An entry is either a step, or a named group with a trigger — which is what a
# consent banner or a login needs.
beforeEach:
  # A consent banner is accepted, not removed: the page is then captured in the
  # state a real visitor sees after agreeing, and no overlay is left to swallow
  # the clicks of later steps. \`when\` means it only runs if the banner is
  # actually there, \`once\` that the decision sticks for the rest of the run.
  - name: accept consent
    when: "#uc-btn-accept-banner"
    once: true
    steps:
      - click: "#uc-btn-accept-banner"
      - waitForTimeout: 500

  # A login, only on the side that needs one.
  # - name: log in
  #   side: b
  #   once: true
  #   steps:
  #     - goto: /login
  #     - fill: { selector: "#user", value: "editor" }
  #     - fill: { selector: "#pass", value: "secret" }
  #     - click: "button[type=submit]"
  #     - waitForUrl: "**/dashboard"

  # A plain step needs no wrapper.
  # - addStyle: ".chat-widget { display: none }"

# Several sites checked the same way: each group brings its own pair of URLs
# and its own pages, and inherits everything it does not state. Its scenarios
# are named <group>/<page>, so two sites may both have a page called index.
#
# groups:
#   - name: shop
#     compare:
#       a: https://shop.ddev.site/
#       b: https://shop.example.com/
#     scenarios:
#       - /
#       - /products
#       - /cart
#
#   - name: blog
#     compare:
#       a: https://blog.ddev.site/
#       b: https://blog.example.com/
#     viewports: [desktop]           # this one only on desktop
#     waitUntil: domcontentloaded    # a site that never goes quiet
#     steps:                         # run on every page of the group
#       - click: "#accept"
#     diff:
#       mask: [".published-at"]      # and with its own mask
#     scenarios:
#       - /
#       - /latest

scenarios:
  # Shorthand: a bare path. The scenario is named after it and runs in every
  # viewport declared above.
  - /
  - /products
  - /about

  # Long form for anything that needs more.
  - name: home-with-menu-open
    path: /
    viewports: [mobile]      # names only
    fullPage: false          # the open menu lives in the viewport
    steps:
      - click: "button.nav-toggle"
      - waitFor: ".nav--open"
      - waitForTimeout: 300

  - name: search-results
    path: /search
    viewports: [desktop]
    steps:
      - fill: { selector: "input[name=q]", value: "shoes" }
      - press: { selector: "input[name=q]", key: "Enter" }
      - waitForLoadState: networkidle
      - waitFor: ".results"
    # Paint over content that legitimately differs between the two systems.
    mask:
      - ".result__timestamp"
    threshold: 0.005

  - name: contact
    # Paths may differ per side when routes changed during the relaunch.
    a: /kontakt
    b: /contact

  - name: footer-only
    path: /
    clip: "footer"           # screenshot just this element

# What the page says while it is photographed, recorded per side and compared
# the way the markup is. A page that looks different often looks different for
# a reason it already announced: a script that threw before it laid anything
# out, an image that came back 404, a font that never arrived. Lines both sides
# log are how the site is; lines only one side logs are the ones to look at.
logs:
  enabled: true
  # Beyond the console levels: pageerror is an uncaught exception,
  # requestfailed a request that never completed, httperror a response that
  # came back 400 or worse. "log" and "info" are left out on purpose — a
  # chatty site writes thousands of those and none of them explains a picture.
  levels: [error, warning, pageerror, requestfailed, httperror]
  # Noise that says nothing about this comparison.
  ignore:
    - "Tracking Prevention blocked"
    # - "googletagmanager"
  max: 50                   # distinct lines kept per side
  failOnDifference: false   # true = an error on one side alone fails the case

# Take one side from an earlier run instead of photographing it again. While a
# regression is being chased only the local side moves: the reference is
# production, unchanged for hours, and the slower of the two because it goes
# over the network. Usually given on the command line for one measuring
# session rather than kept here:
#
#   diffyard run diffyard.yaml --reuse a
#   diffyard run diffyard.yaml --reuse a --reuse-from nightly
#   diffyard run diffyard.yaml --refresh a      # take side A fresh again, once
#
# A shot is only reused while the settings that produced it still hold: same
# address, viewport, steps, masks, browser options. Anything else is captured
# again and says so.
# reuse:
#   side: a
#   from: latest            # or the id of a particular run
#   maxAge: 24h             # warn beyond this; 0 to never warn

# Alongside the pixel diff, the serialised DOM of both sides is compared. The
# HTML is captured after the scenario's steps ran, so an opened menu is part of
# the comparison.
markup:
  enabled: true
  failOnDifference: false   # true = markup changes alone make a scenario fail
  normalizeWhitespace: true
  sortAttributes: false     # true when attribute order is not stable
  # Attributes that legitimately differ between the systems. Supports wildcards.
  ignoreAttributes:
    - nonce
    - data-csrf-token
    # - "data-reactid*"
  # Tag names whose whole subtree is skipped.
  ignoreSelectors:
    - script

# Available steps:
#   click, dblclick, hover, focus                     - selector
#   fill: { selector, value }                         - type into a field
#   press: { selector?, key }                         - keyboard input
#   select: { selector, value }                       - <select> option
#   check / uncheck                                   - selector
#   waitFor / waitForHidden                           - selector
#   waitForText: { selector?, text }
#   waitForTimeout: 500                               - milliseconds
#   waitForUrl: "**/done"
#   waitForLoadState: networkidle
#   scrollTo: selector | scrollToBottom: true | scrollToTop: true | scrollBy: 400
#   goto: "/other-page"
#   evaluate: "document.body.classList.add('x')"
#   addStyle: ".ad { display: none }"
#   setViewport: { width: 1280, height: 720 }
#
# Every step also accepts:
#   timeout: 5000     - override the global timeout for this step
#   optional: true    - do not fail the scenario when the step cannot run
`;
