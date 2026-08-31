/**
 * JSON Schema for the config file.
 *
 * It exists for editors — the YAML language server validates and completes
 * against it. It is deliberately not used for loading: the hand-written parser
 * produces errors that name the option and say what to do, which a schema
 * validator cannot.
 */

const SELECTOR_LIST = {
  description: 'A CSS selector, or a list of them.',
  oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
} as const;

const STEP_ACTIONS: Record<string, unknown> = {
  click: { type: 'string', description: 'Click the first element matching this selector.' },
  dblclick: { type: 'string' },
  hover: { type: 'string' },
  focus: { type: 'string' },
  fill: {
    type: 'object',
    description: 'Type a value into a field.',
    properties: { selector: { type: 'string' }, value: { type: 'string' } },
    required: ['selector', 'value'],
    additionalProperties: false,
  },
  press: {
    type: 'object',
    description: 'Press a key, on an element or on the page.',
    properties: { selector: { type: 'string' }, key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  select: {
    type: 'object',
    description: 'Choose an option in a <select>.',
    properties: {
      selector: { type: 'string' },
      value: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    },
    required: ['selector', 'value'],
    additionalProperties: false,
  },
  check: { type: 'string' },
  uncheck: { type: 'string' },
  waitFor: { type: 'string', description: 'Wait until this selector is visible.' },
  waitForHidden: { type: 'string' },
  waitForText: {
    type: 'object',
    properties: { selector: { type: 'string' }, text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  waitForTimeout: { type: 'number', description: 'Wait this many milliseconds. Use sparingly.' },
  waitForUrl: { type: 'string' },
  waitForLoadState: { enum: ['load', 'domcontentloaded', 'networkidle'] },
  scrollTo: { type: 'string' },
  scrollToBottom: { type: 'boolean' },
  scrollToTop: { type: 'boolean' },
  scrollBy: { type: 'number' },
  goto: { type: 'string' },
  evaluate: { type: 'string', description: 'JavaScript evaluated in the page.' },
  addStyle: { type: 'string', description: 'CSS injected into the page.' },
  setViewport: {
    type: 'object',
    properties: { width: { type: 'number' }, height: { type: 'number' } },
    required: ['width', 'height'],
    additionalProperties: false,
  },
};

const SIDE = {
  description: 'One side of the comparison: a URL, or a mapping with connection details.',
  oneOf: [
    { type: 'string', format: 'uri', description: 'Base URL of this side.' },
    {
      type: 'object',
      properties: {
        url: { type: 'string', format: 'uri', description: 'Base URL of this side.' },
        label: { type: 'string', description: 'Name shown in the report and the CLI, e.g. "live".' },
        headers: { type: 'object', additionalProperties: { type: 'string' } },
        basicAuth: {
          type: 'object',
          properties: { username: { type: 'string' }, password: { type: 'string' } },
          required: ['username', 'password'],
          additionalProperties: false,
        },
        cookies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              value: { type: 'string' },
              domain: { type: 'string' },
              path: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        storageState: { type: 'string', description: 'Path to a Playwright storage state file.' },
      },
      additionalProperties: false,
    },
  ],
} as const;

export const CONFIG_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/benjaminkott/diffyard/schema/config.json',
  title: 'diffyard configuration',
  description: 'Compares two URLs against each other, scenario by scenario.',
  type: 'object',
  anyOf: [{ required: ['scenarios'] }, { required: ['groups'] }],
  additionalProperties: false,

  properties: {
    compare: {
      type: 'object',
      description:
        'Base configuration for the two sides. Optional: leave it out when every ' +
        'scenario names both addresses in full.',
      properties: { a: SIDE, b: SIDE },
      additionalProperties: false,
    },

    output: {
      type: 'object',
      description: 'Where the results go. Relative paths resolve against the working directory.',
      properties: {
        dir: {
          type: 'string',
          default: '.diffyard-report',
          description:
            'Relative to where diffyard runs, not to this file. A .gitignore is placed inside it.',
        },
        runFolder: {
          type: 'boolean',
          default: true,
          description: 'Give each run its own folder inside dir, named after the start time plus a hash.',
        },
        runId: { type: 'string', description: 'Fixed folder name instead of the generated one.' },
        title: { type: 'string', default: 'diffyard report' },
        images: {
          type: 'string',
          enum: ['png', 'webp'],
          default: 'webp',
          description:
            'What screenshots are stored as. Both are lossless; webp is about two fifths ' +
            'the size, png is for when something else has to read them.',
        },
      },
      additionalProperties: false,
    },

    browser: {
      type: 'object',
      properties: {
        engine: { enum: ['chromium', 'firefox', 'webkit'], default: 'chromium' },
        headless: { type: 'boolean', default: true },
        viewports: {
          type: 'object',
          description: 'Declared once here, referenced by name from the scenarios.',
          additionalProperties: {
            type: 'object',
            properties: {
              width: { type: 'number' },
              height: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
              deviceScaleFactor: { type: 'number', default: 1 },
              dpr: { type: 'number' },
            },
            additionalProperties: false,
          },
        },
        colorScheme: { enum: ['light', 'dark', 'no-preference'], default: 'light' },
        reducedMotion: { type: 'boolean', default: true },
        locale: { type: 'string', examples: ['de-DE'] },
        timezone: { type: 'string', examples: ['Europe/Berlin'] },
        userAgent: { type: 'string' },
        ignoreHTTPSErrors: {
          type: 'boolean',
          default: false,
          description: 'Needed for local self-signed certificates.',
        },
      },
      additionalProperties: false,
    },

    timeouts: {
      type: 'object',
      description: 'All values in milliseconds.',
      properties: {
        action: { type: 'number', default: 30000, description: 'Per Playwright action.' },
        comparison: {
          type: 'number',
          default: 180000,
          description: 'Hard limit for one scenario/viewport pair. 0 disables it.',
        },
        run: { type: 'number', default: 0, description: 'Hard limit for the whole run. 0 disables it.' },
      },
      additionalProperties: false,
    },

    diff: {
      type: 'object',
      properties: {
        threshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.001,
          description: 'Share of differing pixels a comparison may have and still pass.',
        },
        pixelThreshold: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.1,
          description: 'Per-pixel colour tolerance. Higher is more forgiving.',
        },
        ignoreAntialiasing: { type: 'boolean', default: true },
        alignRows: {
          type: 'boolean',
          default: true,
          description:
            'Match rows up before comparing, so a page that only moved down is not reported ' +
            'as one that changed everywhere. The raw number is still recorded; this is the ' +
            'one a scenario passes or fails on.',
        },
        mask: { ...SELECTOR_LIST, description: 'Painted over before the screenshot, on every scenario.' },
        hide: { ...SELECTOR_LIST, description: 'Set to visibility:hidden, on every scenario.' },
        remove: {
          ...SELECTOR_LIST,
          description:
            'Removed from the DOM, on every scenario. Applied before the steps too, so overlays cannot swallow clicks.',
        },
      },
      additionalProperties: false,
    },

    stability: {
      type: 'object',
      description: 'What keeps two live systems comparable.',
      properties: {
        freeze: {
          type: 'boolean',
          default: true,
          description:
            'Stop animations, transitions and the text caret. Video and canvas are hidden, ' +
            'since neither can be held still; they keep their space, so a player that moved ' +
            'still shows as one.',
        },
        triggerLazyLoad: {
          type: 'boolean',
          default: true,
          description: 'Scroll the page once so lazy images load before the screenshot.',
        },
        retries: { type: 'integer', minimum: 0, default: 0, description: 'Retry a failed capture.' },
        workers: {
          type: 'integer',
          minimum: 1,
          default: 1,
          description:
            'How many comparisons run at once. Faster and less deterministic: browsers ' +
            'competing for the machine render at slightly different moments, which pages ' +
            'sensitive to animation or timing can pick up.',
        },
        sequential: {
          type: 'boolean',
          default: false,
          description:
            'Capture the two sides one after another instead of at the same time. Slower, and ' +
            'only worth it when a page is so heavy that two browser contexts distort each other.',
        },
      },
      additionalProperties: false,
    },

    reuse: {
      type: 'object',
      description:
        'Take one side from an earlier run instead of capturing it. While a regression is ' +
        'being chased only the local side moves; the reference is production and unchanged, ' +
        'and it is the slower of the two.',
      properties: {
        side: {
          oneOf: [{ enum: ['a', 'b', 'a,b'] }, { type: 'array', items: { enum: ['a', 'b'] } }],
          description: 'Which side comes from the earlier run.',
        },
        from: {
          type: 'string',
          default: 'latest',
          description: 'Run id to take the shots from, or "latest" for the newest finished run.',
        },
        maxAge: {
          oneOf: [{ type: 'string' }, { type: 'number' }],
          default: '24h',
          description:
            'Warn when the reused shots are older than this — "24h", "90m", or milliseconds. ' +
            'Reusing claims the other side has not changed, and that claim ages. 0 disables it.',
        },
      },
      additionalProperties: false,
    },
    logs: {
      type: 'object',
      description:
        'What the page says while it is photographed. A page that looks different often ' +
        'looks different for a reason it already announced: a script that threw, an image ' +
        'that came back 404, a font that never arrived.',
      properties: {
        enabled: { type: 'boolean', default: true },
        levels: {
          type: 'array',
          items: {
            enum: ['error', 'warning', 'info', 'log', 'debug', 'pageerror', 'requestfailed', 'httperror'],
          },
          default: ['error', 'warning', 'pageerror', 'requestfailed', 'httperror'],
          description:
            'Which kinds to keep. Beyond the console levels: pageerror is an uncaught ' +
            'exception, requestfailed a request that never completed, httperror a response ' +
            'that came back 400 or worse.',
        },
        ignore: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lines containing any of these are dropped: consent tools, analytics.',
        },
        max: { type: 'number', default: 50, description: 'Distinct lines kept per side.' },
        failOnDifference: {
          type: 'boolean',
          default: false,
          description:
            'Fail a comparison when one side logs something serious the other does not. ' +
            'Off by default: a console error is a lead, not a verdict.',
        },
      },
      additionalProperties: false,
    },
    markup: {
      type: 'object',
      description: 'The structural diff of the DOM, captured at screenshot time.',
      properties: {
        enabled: { type: 'boolean', default: true },
        failOnDifference: {
          type: 'boolean',
          default: false,
          description: 'Let markup changes alone fail a scenario.',
        },
        ignoreComments: { type: 'boolean', default: false },
        normalizeWhitespace: { type: 'boolean', default: true },
        sortAttributes: {
          type: 'boolean',
          default: false,
          description: 'Set when attribute order is not stable between the systems.',
        },
        ignoreAttributes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Attribute names to drop. Supports prefix-* wildcards.',
        },
        ignoreSelectors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tag names whose subtree is skipped, e.g. script.',
        },
        maxHunksInReport: { type: 'integer', minimum: 1, default: 200 },
      },
      additionalProperties: false,
    },

    beforeEach: {
      type: 'array',
      description:
        "Runs on every page of both sides, before the scenario's own steps. An entry is " +
        'either a step, or a named group with a trigger — which is what a consent banner ' +
        'or a login needs.',
      items: {
        oneOf: [{ $ref: '#/$defs/step' }, { $ref: '#/$defs/beforeEachGroup' }],
      },
    },

    groups: {
      type: 'array',
      description:
        'Sites, or any other set of pages sharing a pair of URLs. A group states what makes ' +
        'it different — its own compare block, viewports or masks — and inherits the rest.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Prefixes the scenarios of this group.' },
          compare: {
            type: 'object',
            description: 'The two sides for this group, overriding the top-level ones.',
            properties: { a: SIDE, b: SIDE },
            additionalProperties: false,
          },
          viewports: {
            type: 'array',
            items: { type: 'string' },
            description: 'Names from browser.viewports; defaults to all of them.',
          },
          waitUntil: {
            enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
            description:
              'For every page of this group. A site that holds a sub-resource open never ' +
              'reaches networkidle and needs domcontentloaded.',
          },
          steps: { $ref: '#/$defs/steps', description: 'Run on every page of this group.' },
          fullPage: { type: 'boolean', description: 'For every page of this group.' },
          waitForTimeout: { type: 'number', description: 'For every page of this group.' },
          diff: {
            type: 'object',
            description: 'Thresholds and masks for this group only.',
            properties: {
              threshold: { type: 'number', minimum: 0, maximum: 1 },
              mask: SELECTOR_LIST,
              hide: SELECTOR_LIST,
              remove: SELECTOR_LIST,
            },
            additionalProperties: false,
          },
          scenarios: {
            type: 'array',
            minItems: 1,
            items: {
              oneOf: [
                { type: 'string', description: 'A path, e.g. "/about".' },
                { $ref: '#/$defs/scenario' },
              ],
            },
          },
        },
        required: ['name', 'scenarios'],
        additionalProperties: false,
      },
    },

    scenarios: {
      type: 'array',
      minItems: 1,
      description: 'The pages to compare. A bare string is a path; use the object form for anything more.',
      items: {
        oneOf: [
          { type: 'string', description: 'A path, e.g. "/about". The scenario is named after it.' },
          { $ref: '#/$defs/scenario' },
        ],
      },
    },
  },

  $defs: {
    step: {
      type: 'object',
      properties: {
        ...STEP_ACTIONS,
        timeout: { type: 'number', description: 'Override the global timeout for this step.' },
        optional: {
          type: 'boolean',
          description: 'Do not fail the scenario when this step cannot run.',
        },
      },
      additionalProperties: false,
      minProperties: 1,
    },

    steps: {
      type: 'array',
      description: 'Interactions performed after the page loaded and before the screenshot.',
      items: { $ref: '#/$defs/step' },
    },

    beforeEachGroup: {
      type: 'object',
      description: 'Steps that only apply under a condition, such as accepting a consent banner.',
      properties: {
        name: { type: 'string', description: 'Shown in errors and previews.' },
        when: {
          type: 'string',
          description:
            'Selector deciding whether this applies. The group runs once it becomes visible; ' +
            'if it never does, the group is skipped. Without it, the group always runs.',
        },
        timeout: { type: 'number', default: 5000, description: 'How long to wait for the trigger.' },
        required: { type: 'boolean', default: false, description: 'Fail when the trigger never appeared.' },
        once: {
          type: 'boolean',
          default: false,
          description:
            'Run at most once per browser context. For decisions that stick, like a consent ' +
            'cookie or a session.',
        },
        side: { enum: ['a', 'b'], description: 'Limit to one side.' },
        steps: { $ref: '#/$defs/steps' },
      },
      required: ['steps'],
      additionalProperties: false,
    },

    scenario: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Defaults to a slug of the path.' },
        path: {
          type: 'string',
          description: "Appended to each side's base URL, or a full URL used as it is.",
        },
        a: {
          type: 'string',
          description:
            'Address on side A, when the two sides do not sit at the same place. A path is ' +
            "resolved against compare.a's URL; a full URL is used as it is, so scenarios can " +
            'span several hosts.',
        },
        b: { type: 'string', description: 'Address on side B. See a.' },

        viewports: {
          type: 'array',
          items: { type: 'string' },
          description: 'Names of viewports declared under browser.viewports. Defaults to all of them.',
        },
        steps: { $ref: '#/$defs/steps' },
        fullPage: {
          type: 'boolean',
          default: true,
          description: 'Capture the whole page. Set false for a state that lives in the viewport, like an open menu.',
        },
        clip: { type: 'string', description: 'Screenshot only this element.' },
        mask: SELECTOR_LIST,
        hide: SELECTOR_LIST,
        remove: SELECTOR_LIST,
        threshold: { type: 'number', minimum: 0, maximum: 1 },
        waitForTimeout: { type: 'number', description: 'Settle time before the screenshot.' },
        waitUntil: {
          enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
          default: 'networkidle',
        },
        skip: { type: 'boolean', default: false },
        only: { type: 'boolean', default: false, description: 'Run only the scenarios marked this way.' },
      },
      anyOf: [{ required: ['path'] }, { required: ['a', 'b'] }],
      additionalProperties: false,
    },
  },
} as const;

export const SCHEMA_FILENAME = 'diffyard.schema.json';

export function schemaJson(): string {
  return `${JSON.stringify(CONFIG_SCHEMA, null, 2)}\n`;
}
