import { expect, IJupyterLabPageFixture, test } from '@jupyterlab/galata';
import { Locator } from '@playwright/test';

const KERNEL_NAME = 'JavaScript (QuickJS)';

/**
 * Open a new notebook with the kernel, from the launcher.
 */
async function openNotebook(page: IJupyterLabPageFixture): Promise<void> {
  await page
    .locator('.jp-LauncherCard[data-category="Notebook"]', {
      hasText: KERNEL_NAME
    })
    .click();
  await page.locator('.jp-Notebook').waitFor();
  // The execution requests sent while the kernel starts are ignored, see
  // https://github.com/jupyterlab/jupyterlab/issues/15420
  await expect(page.locator('#jp-main-statusbar')).toContainText(
    `${KERNEL_NAME} | Idle`,
    {
      timeout: 30000
    }
  );
}

/**
 * The last cell of the notebook. Running it adds a new cell, so the locator
 * targets the cell by its index.
 */
async function lastCell(page: IJupyterLabPageFixture): Promise<Locator> {
  const cells = page.locator('.jp-Notebook .jp-CodeCell');
  return cells.nth((await cells.count()) - 1);
}

/**
 * Type code in the last cell of the notebook, and run it with Shift+Enter.
 */
async function runCell(
  page: IJupyterLabPageFixture,
  code: string
): Promise<Locator> {
  const cell = await lastCell(page);
  await typeInCell(cell, code);
  await page.keyboard.press('Shift+Enter');
  await expect(cell.locator('.jp-InputPrompt')).toHaveText(/\[\d+\]:/);
  return cell;
}

/**
 * The output of the result of a cell, without its prompt.
 */
function result(cell: Locator): Locator {
  return cell.locator('.jp-OutputArea-executeResult .jp-OutputArea-output');
}

async function typeInCell(cell: Locator, code: string): Promise<void> {
  const editor = cell.getByRole('textbox');
  await editor.click();
  // The editor indents the new lines itself
  await editor.pressSequentially(code);
}

test.describe('xeus-quickjs', () => {
  test.beforeEach(async ({ page }) => {
    await openNotebook(page);
  });

  test('should show the kernel with its logo in the launcher', async ({
    page
  }) => {
    await page.getByRole('menuitem', { name: 'File' }).click();
    await page.getByRole('menuitem', { name: 'New Launcher' }).click();
    const card = page.locator('.jp-LauncherCard[data-category="Notebook"]', {
      hasText: KERNEL_NAME
    });
    await expect(card).toBeVisible();
    await expect(card.locator('img')).toHaveAttribute('src', /xquickjs\/logo/);
  });

  test('should execute code', async ({ page }) => {
    let cell = await runCell(
      page,
      'const answer = 6 * 7;\nconsole.log("The answer is", answer);\nanswer'
    );
    await expect(cell.locator('.jp-OutputArea-output').first()).toHaveText(
      'The answer is 42'
    );
    await expect(result(cell)).toHaveText('42');

    // Declarations can be executed again
    cell = await runCell(page, 'const answer = 43;\nanswer');
    await expect(result(cell)).toHaveText('43');
  });

  test('should show the errors', async ({ page }) => {
    const cell = await runCell(
      page,
      'function inner() { null.value }\ninner()'
    );
    const error = cell.locator(
      '.jp-OutputArea-output[data-mime-type="application/vnd.jupyter.stderr"]'
    );
    await expect(error).toContainText(
      "TypeError: cannot read property 'value' of null"
    );
    await expect(error).toContainText('at inner (In[1]:1:24)');
  });

  test('should display rich outputs', async ({ page }) => {
    const cell = await runCell(
      page,
      "display.html('<b class=\"rich\">bold</b>');\ndisplay.markdown('# Title');"
    );
    await expect(cell.locator('b.rich')).toHaveText('bold');
    await expect(cell.getByRole('heading', { name: 'Title' })).toBeVisible();
  });

  test('should complete code', async ({ page }) => {
    await runCell(page, 'const myFavoriteNumber = 7;');
    const cell = await lastCell(page);
    await typeInCell(cell, 'myFav');
    await page.keyboard.press('Tab');
    const completer = page.locator('.jp-Completer');
    await expect(
      completer.getByText('myFavoriteNumber', { exact: true })
    ).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(cell.getByRole('textbox')).toHaveText('myFavoriteNumber');

    await page.keyboard.type(' + Math.');
    await page.keyboard.press('Tab');
    await expect(completer.getByText('max', { exact: true })).toBeVisible();
    await expect(completer.getByText('PI', { exact: true })).toBeVisible();
  });

  test('should inspect code', async ({ page }) => {
    await runCell(
      page,
      '/** Greets someone. */\nfunction greet(name, greeting = "Hello") { return `${greeting} ${name}` }'
    );
    const cell = await lastCell(page);
    await typeInCell(cell, 'greet(');
    await page.keyboard.press('Shift+Tab');
    const tooltip = page.locator('.jp-Tooltip');
    await expect(tooltip).toContainText(
      'Signature: greet(name, greeting = "Hello")'
    );
    await expect(tooltip).toContainText('Docstring: Greets someone.');
  });

  test.describe(() => {
    // The tracking of the kernels by galata fails on the empty response of the
    // interrupt requests: disable it.
    test.use({ kernels: null, sessions: null });

    test('should interrupt the kernel', async ({ page }) => {
      const cell = await lastCell(page);
      await typeInCell(cell, 'let count = 0;\nwhile (true) { count++ }');
      await page.keyboard.press('Shift+Enter');
      await expect(cell.locator('.jp-InputPrompt')).toHaveText('[*]:');
      await page.getByRole('button', { name: 'Interrupt the kernel' }).click();
      await expect(cell.locator('.jp-OutputArea-output')).toContainText(
        'InternalError: interrupted'
      );

      const next = await runCell(page, 'count > 0');
      await expect(result(next)).toHaveText('true');

      // The kernel is not tracked by galata
      await page.getByRole('menuitem', { name: 'Kernel' }).click();
      await page.getByRole('menuitem', { name: 'Shut Down Kernel' }).click();
      await expect(page.locator('#jp-main-statusbar')).toContainText(
        'No Kernel'
      );
    });
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
    await expect(cell.locator('.widget-slider')).toBeVisible();
    await expect(cell.locator('.widget-readout')).toHaveText('3');

    await cell.getByRole('button', { name: 'Square' }).click();
    await expect(cell.locator('.widget-output')).toHaveText('Square: 9');

    // The kernel updates the widget
    await runCell(page, 'slider.value = 8;');
    await expect(cell.locator('.widget-readout')).toHaveText('8');
  });
});
