import { expect, test } from '@playwright/test';
import {
  KERNEL_NAME,
  lastCell,
  openNotebook,
  result,
  runCell,
  typeInCell,
  waitForKernel
} from './utils';

test.describe('xeus-quickjs in JupyterLite', () => {
  test.beforeEach(async ({ page }) => {
    await openNotebook(page);
  });

  test('should show the kernel in the launcher', async ({ page }) => {
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'New Launcher' }).click();
    const card = page.locator('.jp-LauncherCard[data-category="Notebook"]', {
      hasText: KERNEL_NAME
    });
    await expect(card.locator('img')).toHaveAttribute('src', /logo/);
  });

  test('should execute code in WebAssembly', async ({ page }) => {
    const cell = await runCell(
      page,
      "const { platform } = await import('os');\nconsole.log('Hello from QuickJS');\nplatform"
    );
    await expect(cell.locator('.jp-OutputArea-output').first()).toHaveText(
      'Hello from QuickJS'
    );
    // emscripten is the platform of QuickJS
    await expect(result(cell)).toHaveText("'js'");

    const next = await runCell(
      page,
      'await new Promise(resolve => setTimeout(resolve, 200));\n[1, 2, 3].map(x => x ** 2)'
    );
    await expect(result(next)).toHaveText('[ 1, 4, 9 ]');
  });

  test('should show rich outputs and errors', async ({ page }) => {
    const cell = await runCell(
      page,
      'display.html(\'<b class="rich">bold</b>\');\nnull.value'
    );
    await expect(cell.locator('b.rich')).toHaveText('bold');
    const error = cell.locator(
      '.jp-OutputArea-output[data-mime-type="application/vnd.jupyter.stderr"]'
    );
    await expect(error).toContainText(
      "TypeError: cannot read property 'value' of null"
    );
  });

  test('should show the output of QuickJS', async ({ page }) => {
    const cell = await runCell(
      page,
      "import * as std from 'std';\nstd.printf('%s %d\\n', 'printf', 42);"
    );
    await expect(cell.locator('.jp-OutputArea-output')).toHaveText('printf 42');
  });

  test('should import modules from the files of JupyterLite', async ({
    page
  }) => {
    const cell = await runCell(
      page,
      "import { area } from './modules/geometry.mjs';\narea({ width: 3, height: 4 })"
    );
    await expect(result(cell)).toHaveText('12');
  });

  test('should write files in the file browser', async ({ page }) => {
    const cell = await runCell(
      page,
      [
        "import * as std from 'std';",
        "const file = std.open('from-quickjs.txt', 'w');",
        "file.puts('Hello from QuickJS');",
        'file.close();',
        "std.loadFile('from-quickjs.txt')"
      ].join('\n')
    );
    await expect(result(cell)).toHaveText("'Hello from QuickJS'");
    await expect(
      page.locator('.jp-DirListing-item', { hasText: 'from-quickjs.txt' })
    ).toBeVisible();
  });

  test('should run the files notebook', async ({ page }) => {
    await page
      .locator('.jp-DirListing-item', { hasText: 'files.ipynb' })
      .dblclick();
    await page.getByRole('tab', { name: 'files.ipynb' }).waitFor();
    await waitForKernel(page);
    await page.getByRole('menuitem', { name: 'Run' }).click();
    await page
      .getByRole('menuitem', { name: 'Run All Cells', exact: true })
      .click();

    const notebook = page.getByRole('tabpanel', { name: 'files.ipynb' });
    const cells = notebook.locator('.jp-CodeCell');
    await expect(cells.last().locator('.jp-InputPrompt')).toHaveText(
      /\[\d+\]:/,
      { timeout: 60000 }
    );
    await expect(result(cells.first())).toHaveText("[ '/drive', 0 ]");
    await expect(notebook.locator('.jp-RenderedSVG')).toBeVisible();
    await expect(result(cells.last())).toHaveText('[ null, false ]');
    await expect(
      notebook.locator('[data-mime-type="application/vnd.jupyter.stderr"]')
    ).toHaveCount(0);
  });

  test('should complete code', async ({ page }) => {
    const cell = await lastCell(page);
    await typeInCell(cell, 'Math.ma');
    await page.keyboard.press('Tab');
    const completer = page.locator('.jp-Completer');
    await expect(completer.getByText('max', { exact: true })).toBeVisible();
  });

  test('should inspect code', async ({ page }) => {
    const cell = await lastCell(page);
    await typeInCell(cell, 'JSON.parse(');
    await page.keyboard.press('Shift+Tab');
    await expect(page.locator('.jp-Tooltip')).toContainText(
      'Global_Objects/JSON/parse'
    );
  });

  test('should ask for input', async ({ page }) => {
    const cell = await lastCell(page);
    await typeInCell(
      cell,
      'const name = prompt("Your name:");\n`Hello ${name}!`'
    );
    await page.keyboard.press('Shift+Enter');
    const input = cell.locator('.jp-Stdin-input');
    await expect(input).toBeVisible();
    await input.fill('Ada');
    await input.press('Enter');
    await expect(result(cell)).toHaveText("'Hello Ada!'");
  });

  test('should show widgets', async ({ page }) => {
    const cell = await runCell(
      page,
      [
        'const { IntSlider, Button, Output, VBox } = Jupyter.widgets;',
        'const slider = new IntSlider({ value: 3, max: 10, description: "Value" });',
        'const out = new Output();',
        'const button = new Button({ description: "Square" });',
        'button.onClick(out.capture(() => console.log("Square:", slider.value ** 2)));',
        'new VBox({ children: [slider, button, out] })'
      ].join('\n')
    );
    await expect(cell.locator('.widget-readout')).toHaveText('3');
    await cell.getByRole('button', { name: 'Square' }).click();
    await expect(cell.locator('.widget-output')).toHaveText('Square: 9');

    await runCell(page, 'slider.value = 8;');
    await expect(cell.locator('.widget-readout')).toHaveText('8');
  });
});
