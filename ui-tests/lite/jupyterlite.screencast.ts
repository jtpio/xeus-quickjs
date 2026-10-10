/**
 * Screencast of xeus-quickjs in JupyterLite, in screencast-results/jupyterlite.mp4
 */
import { expect, Page, test } from '@playwright/test';
import path from 'path';
import {
  installCursor,
  installKeycast,
  installLargerFonts,
  Pointer,
  Recorder
} from '../screencast/recorder';
import { KERNEL_NAME, waitForKernel } from './utils';

const OUTPUT = path.resolve(
  __dirname,
  '..',
  'screencast-results',
  'jupyterlite.mp4'
);

/**
 * Type the lines of a cell like a person would. The editor indents them.
 */
async function typeLines(page: Page, lines: string[]): Promise<void> {
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.press('Enter');
    }
    await page.keyboard.type(lines[i], { delay: 25 });
  }
}

async function run(page: Page, index: number, pause = 1500): Promise<void> {
  await page.keyboard.press('Shift+Enter');
  await expect(
    page
      .locator('.jp-Notebook .jp-CodeCell')
      .nth(index)
      .locator('.jp-InputPrompt')
  ).toHaveText(/\[\d+\]:/, { timeout: 60000 });
  await page.waitForTimeout(pause);
}

test('jupyterlite', async ({ page }) => {
  await installCursor(page);
  await installKeycast(page);
  await installLargerFonts(page);

  await page.goto('lab/index.html');
  const card = page.locator('.jp-LauncherCard[data-category="Notebook"]', {
    hasText: KERNEL_NAME
  });
  await card.waitFor();
  await page.getByText('mandelbrot.ipynb').waitFor();

  const start = { x: 900, y: 560 };
  await page.mouse.move(start.x, start.y);
  const pointer = new Pointer(page, start);
  const recorder = new Recorder(page, { path: OUTPUT });
  await recorder.start();
  await page.waitForTimeout(1500);

  // A new notebook, with the kernel running in the browser
  await pointer.click(card);
  await page.locator('.jp-Notebook').waitFor();
  await waitForKernel(page);
  await page.waitForTimeout(800);

  const cells = page.locator('.jp-Notebook .jp-CodeCell');
  await pointer.click(cells.nth(0).getByRole('textbox'));
  await typeLines(page, [
    "const { platform } = await import('os');",
    "`QuickJS ${platform === 'js' ? 'in WebAssembly' : 'natively'}`"
  ]);
  await run(page, 0);

  await typeLines(page, [
    "console.table([{ engine: 'QuickJS', runtime: 'WebAssembly', server: 'none' }]);"
  ]);
  await run(page, 1);

  await page.keyboard.type('Math.', { delay: 60 });
  await page.keyboard.press('Tab');
  await page.locator('.jp-Completer').waitFor();
  await page.waitForTimeout(1200);
  await page.keyboard.type('hy', { delay: 200 });
  await page.waitForTimeout(600);
  await page.keyboard.press('Enter');
  await page.keyboard.type('(3, 4)', { delay: 60 });
  await page.waitForTimeout(400);
  await run(page, 2);

  await typeLines(page, [
    'const { IntSlider, HTML, HBox } = Jupyter.widgets;',
    "const slider = new IntSlider({ value: 4, max: 12, description: 'n' });",
    'const square = new HTML();',
    "slider.observe(({ new: n }) => { square.value = `<b>${n}² = ${n * n}</b>`; }, 'value');",
    'new HBox({ children: [slider, square] })'
  ]);
  await run(page, 3, 800);
  const handle = cells.nth(3).locator('.noUi-handle');
  await pointer.drag(handle, { x: 70, y: 0 });
  await page.waitForTimeout(800);
  await pointer.drag(handle, { x: -40, y: 0 });
  await page.waitForTimeout(1200);

  // An example notebook, computing the Mandelbrot set in WebAssembly
  await pointer.dblclick(
    page.locator('.jp-DirListing-item', { hasText: 'mandelbrot.ipynb' })
  );
  await page.getByRole('tab', { name: 'mandelbrot.ipynb' }).waitFor();
  await waitForKernel(page);
  await page.waitForTimeout(800);
  await pointer.click(page.getByRole('menuitem', { name: 'Run' }));
  await pointer.click(
    page.getByRole('menuitem', { name: 'Run All Cells', exact: true })
  );
  const explorer = page
    .getByRole('tabpanel', { name: 'mandelbrot.ipynb' })
    .locator('.widget-image');
  await explorer.waitFor({ timeout: 60000 });
  await page.waitForTimeout(1000);
  // Scroll down to the explorer, smoothly
  await pointer.moveTo(
    page.getByRole('tabpanel', { name: 'mandelbrot.ipynb' })
  );
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 35);
    await page.waitForTimeout(30);
  }
  await page.waitForTimeout(1200);

  const sliders = page
    .getByRole('tabpanel', { name: 'mandelbrot.ipynb' })
    .locator('.widget-slider');
  const dragTo = async (index: number, fraction: number) => {
    const slider = sliders.nth(index);
    const track = await slider.locator('.noUi-target').boundingBox();
    const sliderHandle = await slider.locator('.noUi-handle').boundingBox();
    const x =
      track!.x +
      track!.width * fraction -
      (sliderHandle!.x + sliderHandle!.width / 2);
    await pointer.drag(slider.locator('.noUi-handle'), { x, y: 0 });
    await page.waitForTimeout(2500);
  };
  // x from -2 to 1, y from -1.2 to 1.2, zoom from 2^0 to 2^10
  await dragTo(0, (-0.745 + 2) / 3);
  await dragTo(1, (0.11 + 1.2) / 2.4);
  await dragTo(2, 0.45);
  await page.waitForTimeout(1500);
  await recorder.stop();
});
