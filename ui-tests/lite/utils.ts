import { expect, Locator, Page } from '@playwright/test';

export const KERNEL_NAME = 'JavaScript (xquickjs)';

/**
 * Open JupyterLite, and a new notebook with the kernel from the launcher.
 */
export async function openNotebook(page: Page): Promise<void> {
  await page.goto('lab/index.html');
  await page
    .locator('.jp-LauncherCard[data-category="Notebook"]', {
      hasText: KERNEL_NAME
    })
    .click();
  await page.locator('.jp-Notebook').waitFor();
  await waitForKernel(page);
}

/**
 * Wait until the kernel, running in a web worker, is ready.
 */
export async function waitForKernel(page: Page): Promise<void> {
  await expect(page.locator('#jp-main-statusbar')).toContainText(
    `${KERNEL_NAME} | Idle`,
    { timeout: 60000 }
  );
}

/**
 * The last cell of the notebook. Running it adds a new cell, so the locator
 * targets the cell by its index.
 */
export async function lastCell(page: Page): Promise<Locator> {
  const cells = page.locator('.jp-Notebook .jp-CodeCell');
  return cells.nth((await cells.count()) - 1);
}

export async function typeInCell(cell: Locator, code: string): Promise<void> {
  const editor = cell.getByRole('textbox');
  await editor.click();
  // The editor indents the new lines itself
  await editor.pressSequentially(code);
}

/**
 * Type code in the last cell of the notebook, and run it with Shift+Enter.
 */
export async function runCell(page: Page, code: string): Promise<Locator> {
  const cell = await lastCell(page);
  await typeInCell(cell, code);
  await page.keyboard.press('Shift+Enter');
  await expect(cell.locator('.jp-InputPrompt')).toHaveText(/\[\d+\]:/, {
    timeout: 30000
  });
  return cell;
}

/**
 * The output of the result of a cell, without its prompt.
 */
export function result(cell: Locator): Locator {
  return cell.locator('.jp-OutputArea-executeResult .jp-OutputArea-output');
}
