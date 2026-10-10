/**
 * Screencast of the README: a tour of the kernel in JupyterLite, with the
 * xeus-quickjs.ipynb notebook, in screencast-results/jupyterlite.mp4
 */
import { expect, Locator, Page, test } from '@playwright/test';
import path from 'path';
import {
  installCursor,
  installLargerFonts,
  Pointer,
  Recorder
} from '../screencast/recorder';
import { waitForKernel } from './utils';

const OUTPUT = path.resolve(
  __dirname,
  '..',
  'screencast-results',
  'jupyterlite.mp4'
);

const NOTEBOOK = 'xeus-quickjs.ipynb';

test('jupyterlite', async ({ page }) => {
  await installCursor(page);
  await installLargerFonts(page);

  await page.goto('lab/index.html');
  const file = page.locator('.jp-DirListing-item', { hasText: NOTEBOOK });
  await file.waitFor();
  await page.locator('.jp-LauncherCard').first().waitFor();

  const viewport = page.viewportSize()!;
  const start = { x: viewport.width * 0.6, y: viewport.height * 0.7 };
  await page.mouse.move(start.x, start.y);
  const pointer = new Pointer(page, start);
  const recorder = new Recorder(page, { path: OUTPUT });
  await recorder.start();
  await page.waitForTimeout(1200);

  // Open the notebook from the file browser, then collapse the file browser
  await pointer.dblclick(file);
  const panel = page.getByRole('tabpanel', { name: NOTEBOOK });
  await panel.locator('.jp-Notebook .jp-Cell').first().waitFor();
  await pointer.click(
    page.locator('.jp-SideBar.jp-mod-left .lm-TabBar-tab.lm-mod-current')
  );
  await expect(page.locator('#jp-left-stack')).toBeHidden();
  await waitForKernel(page);

  const tour = new Tour(page, pointer);
  await page.waitForTimeout(600);

  // Expressions, and values displayed like in Node.js
  await tour.run(600); // # xeus-quickjs
  await tour.run(150); // ## Expressions
  await tour.run(700); // 1 + 2 + 3
  await tour.run(800); // `${greeting}, ${engine}!`
  await tour.run(300); // const answer = 42;
  await tour.run(150);
  await tour.run(800); // const answer = 43;
  await tour.run(150);
  await tour.run(1500); // person
  await tour.run(1000); // squares
  await tour.run(1500); // BigInt, Symbol, RegExp, Date
  await tour.run(150);
  await tour.run(700); // _.length

  // Functions and classes
  await tour.run(150);
  await tour.run(1000); // class Point
  await tour.run(700); // norm()
  await tour.run(1100); // fibonacci

  // The console, and errors
  await tour.run(150);
  await tour.run(1800); // console.log
  await tour.run(1800); // console.table
  await tour.run(150);
  await tour.run(2200); // JSON.parse error

  // Top-level await and timers
  await tour.run(150);
  await tour.run(800); // await sleep(1000)
  await tour.run(1200); // timers

  // Rich display
  await tour.run(150);
  await tour.run(1700); // Markdown and HTML
  await tour.run(1200); // _toHtml

  // User input
  await tour.run(150);
  const promptCell = await tour.run(0, false);
  // The input box has the focus
  const input = panel.locator('.jp-Stdin-input');
  await expect(input).toBeFocused();
  await pointer.moveTo(input);
  await page.waitForTimeout(300);
  await page.keyboard.type('Ada', { delay: 140 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await tour.waitForCell(promptCell);
  await page.waitForTimeout(1200);
  // The input box made its cell active, select the next one
  await pointer.click(tour.cell(promptCell + 1).locator('.jp-InputPrompt'));
  await page.waitForTimeout(300);

  // Modules
  await tour.run(150);
  await tour.run(1200); // os and std

  // Widgets
  await tour.run(150);
  const widget = await tour.run(800); // IntSlider
  const handle = tour.cell(widget).locator('.noUi-handle');
  await pointer.drag(handle, { x: 160, y: 0 }, 1400);
  await page.waitForTimeout(900);
  await pointer.drag(handle, { x: -70, y: 0 }, 1000);
  await page.waitForTimeout(1800);

  // Code completion, in a new cell
  await pointer.click(
    panel.locator('.jp-Toolbar-item[data-jp-item-name="insert"]')
  );
  await pointer.click(tour.cell(await tour.active()).locator('.jp-Editor'));
  await page.keyboard.type('person.languages.', { delay: 70 });
  await page.keyboard.press('Tab');
  await page.locator('.jp-Completer').waitFor();
  await page.waitForTimeout(1000);
  await page.keyboard.type('ma', { delay: 220 });
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.keyboard.type('(language => language.toUpperCase())', {
    delay: 50
  });
  await page.waitForTimeout(500);
  await tour.run(2500);

  await recorder.stop();
});

/**
 * Run the cells of the notebook one after the other, with the run button of
 * the toolbar.
 */
class Tour {
  constructor(
    protected page: Page,
    protected pointer: Pointer
  ) {
    this.panel = page.getByRole('tabpanel', { name: NOTEBOOK });
  }

  cell(index: number): Locator {
    return this.panel.locator('.jp-Notebook .jp-Cell').nth(index);
  }

  /**
   * The index of the active cell.
   */
  async active(): Promise<number> {
    return this.panel
      .locator('.jp-Notebook .jp-Cell')
      .evaluateAll(cells =>
        cells.findIndex(cell => cell.classList.contains('jp-mod-active'))
      );
  }

  /**
   * Run the active cell, which selects the next one, and return its index.
   */
  async run(pause: number, wait = true): Promise<number> {
    const index = await this.active();
    await this.pointer.click(
      this.panel.locator('.jp-Toolbar-item[data-jp-item-name="run"]')
    );
    if (wait) {
      await this.waitForCell(index);
    }
    await this.page.waitForTimeout(pause);
    return index;
  }

  /**
   * Wait until a code cell has run.
   */
  async waitForCell(index: number): Promise<void> {
    const cell = this.cell(index);
    if (await cell.evaluate(node => node.classList.contains('jp-CodeCell'))) {
      await expect(cell.locator('.jp-InputPrompt')).toHaveText(/\[\d+\]:/, {
        timeout: 60000
      });
    }
  }

  protected panel: Locator;
}
