import type { Page } from 'playwright';
import type { Step } from './types.js';

/**
 * Executes one declarative step from the config against a live page.
 *
 * Steps are intentionally narrow: everything that needs real logic belongs in
 * `evaluate`, so the YAML stays readable and side-effect free otherwise.
 */
export async function runStep(page: Page, step: Step, defaultTimeout: number): Promise<void> {
  const timeout = 'timeout' in step && typeof step.timeout === 'number' ? step.timeout : defaultTimeout;

  if ('click' in step) return void (await page.locator(step.click).first().click({ timeout }));
  if ('dblclick' in step) return void (await page.locator(step.dblclick).first().dblclick({ timeout }));
  if ('hover' in step) return void (await page.locator(step.hover).first().hover({ timeout }));
  if ('focus' in step) return void (await page.locator(step.focus).first().focus({ timeout }));

  if ('fill' in step) {
    return void (await page.locator(step.fill.selector).first().fill(step.fill.value, { timeout }));
  }

  if ('press' in step) {
    if (step.press.selector) {
      return void (await page.locator(step.press.selector).first().press(step.press.key, { timeout }));
    }
    return void (await page.keyboard.press(step.press.key));
  }

  if ('select' in step) {
    return void (await page.locator(step.select.selector).first().selectOption(step.select.value, { timeout }));
  }

  if ('check' in step) return void (await page.locator(step.check).first().check({ timeout }));
  if ('uncheck' in step) return void (await page.locator(step.uncheck).first().uncheck({ timeout }));

  if ('waitFor' in step) {
    return void (await page.locator(step.waitFor).first().waitFor({ state: 'visible', timeout }));
  }

  if ('waitForHidden' in step) {
    return void (await page.locator(step.waitForHidden).first().waitFor({ state: 'hidden', timeout }));
  }

  if ('waitForText' in step) {
    const scope = step.waitForText.selector ? page.locator(step.waitForText.selector) : page.locator('body');
    return void (await scope.filter({ hasText: step.waitForText.text }).first().waitFor({ state: 'visible', timeout }));
  }

  if ('waitForTimeout' in step) return void (await page.waitForTimeout(step.waitForTimeout));

  if ('waitForUrl' in step) return void (await page.waitForURL(step.waitForUrl, { timeout }));

  if ('waitForLoadState' in step) {
    return void (await page.waitForLoadState(step.waitForLoadState, { timeout }));
  }

  if ('scrollTo' in step) {
    return void (await page.locator(step.scrollTo).first().scrollIntoViewIfNeeded({ timeout }));
  }

  if ('scrollToBottom' in step) {
    return void (await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)));
  }

  if ('scrollToTop' in step) return void (await page.evaluate(() => window.scrollTo(0, 0)));

  if ('scrollBy' in step) {
    const by = step.scrollBy;
    return void (await page.evaluate((amount) => window.scrollBy(0, amount), by));
  }

  if ('goto' in step) {
    return void (await page.goto(step.goto, { timeout, waitUntil: 'networkidle' }));
  }

  if ('evaluate' in step) {
    const source = step.evaluate;
    return void (await page.evaluate((code) => {
      // Indirect eval keeps the snippet in global scope, matching DevTools behaviour.
      return (0, eval)(code);
    }, source));
  }

  if ('addStyle' in step) return void (await page.addStyleTag({ content: step.addStyle }));

  if ('setViewport' in step) {
    return void (await page.setViewportSize({ width: step.setViewport.width, height: step.setViewport.height }));
  }

  // `screenshot` is a no-op marker kept for forward compatibility with
  // multi-shot scenarios; the capture itself happens after all steps ran.
  if ('screenshot' in step) return;

  throw new Error(`Unsupported step: ${JSON.stringify(step)}`);
}

export function describeStep(step: Step): string {
  const [key, value] = Object.entries(step).find(([k]) => k !== 'timeout') ?? ['?', ''];
  const detail = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `${key}: ${detail}`;
}
