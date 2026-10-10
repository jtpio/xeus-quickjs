import { expect, galata, IJupyterLabPageFixture } from '@jupyterlab/galata';
import { APIRequestContext, Locator } from '@playwright/test';
import path from 'path';
import {
  installCursor,
  installKeycast,
  installLargerFonts,
  Pointer,
  Recorder
} from './recorder';

export const KERNEL_NAME = 'JavaScript (QuickJS)';

export const DIRECTORY = 'screencasts';

const RESULTS = path.resolve(__dirname, '..', 'screencast-results');

const METADATA = {
  kernelspec: {
    display_name: KERNEL_NAME,
    language: 'javascript',
    name: 'xquickjs'
  },
  language_info: {
    codemirror_mode: 'javascript',
    file_extension: '.js',
    mimetype: 'text/javascript',
    name: 'javascript',
    nbconvert_exporter: '',
    pygments_lexer: 'javascript',
    version: '2025-09-13'
  }
};

export interface ICell {
  source: string;
  hidden?: boolean;
}

/**
 * Upload a notebook with code cells for a screencast.
 */
export async function uploadNotebook(
  request: APIRequestContext,
  name: string,
  cells: (string | ICell)[]
): Promise<string> {
  const notebook = {
    cells: cells.map((cell, index) => {
      const { source, hidden } =
        typeof cell === 'string' ? { source: cell, hidden: false } : cell;
      return {
        cell_type: 'code',
        execution_count: null,
        id: `cell-${index}`,
        metadata: hidden ? { jupyter: { source_hidden: true } } : {},
        outputs: [],
        source: source.trim()
      };
    }),
    metadata: METADATA,
    nbformat: 4,
    nbformat_minor: 5
  };
  return uploadFile(
    request,
    `${name}.ipynb`,
    JSON.stringify(notebook, null, 1)
  );
}

/**
 * Upload a text file for a screencast.
 */
export async function uploadFile(
  request: APIRequestContext,
  name: string,
  content: string
): Promise<string> {
  const filePath = `${DIRECTORY}/${name}`;
  await galata
    .newContentsHelper(request)
    .uploadContent(content, 'text', filePath);
  return filePath;
}

/**
 * Set up the page for a recording: a visible cursor, the keyboard shortcuts,
 * and larger fonts.
 */
export async function preparePage(page: IJupyterLabPageFixture): Promise<void> {
  await installCursor(page);
  await installKeycast(page);
  await installLargerFonts(page);
}

/**
 * Open a notebook, and wait for its kernel.
 */
export async function openNotebook(
  page: IJupyterLabPageFixture,
  filePath: string,
  options: { sidebar?: boolean } = {}
): Promise<void> {
  await page.goto(`tree/${filePath}`);
  await page.locator('.jp-Notebook').waitFor();
  await waitForKernel(page);
  if (!options.sidebar) {
    // Clicking the current tab of the left sidebar collapses it
    await page
      .locator('.jp-SideBar.jp-mod-left .lm-TabBar-tab.lm-mod-current')
      .click();
    await expect(page.locator('#jp-left-stack')).toBeHidden();
  }
  await page.locator('.jp-Notebook .jp-Cell').first().waitFor();
}

/**
 * Wait until the kernel is ready.
 *
 * The execution requests sent while the kernel starts are ignored, see
 * https://github.com/jupyterlab/jupyterlab/issues/15420
 */
export async function waitForKernel(
  page: IJupyterLabPageFixture
): Promise<void> {
  await expect(page.locator('#jp-main-statusbar')).toContainText(
    `${KERNEL_NAME} | Idle`,
    {
      timeout: 30000
    }
  );
}

/**
 * A screencast of a notebook.
 */
export class Screencast {
  constructor(
    readonly page: IJupyterLabPageFixture,
    readonly name: string
  ) {
    const viewport = page.viewportSize()!;
    this.start = { x: viewport.width - 140, y: viewport.height - 120 };
    this.pointer = new Pointer(page, this.start);
    this.recorder = new Recorder(page, {
      path: path.join(RESULTS, `${name}.mp4`)
    });
  }

  readonly pointer: Pointer;

  /**
   * Start the recording, with the first cell of the notebook selected.
   */
  async begin(options: { selectFirstCell?: boolean } = {}): Promise<void> {
    if (options.selectFirstCell ?? true) {
      await this.page
        .locator('.jp-Notebook .jp-Cell')
        .first()
        .locator('.jp-InputPrompt')
        .click();
    }
    await this.page.mouse.move(this.start.x, this.start.y);
    await this.recorder.start();
    await this.page.waitForTimeout(1500);
  }

  async end(pause = 2500): Promise<void> {
    await this.page.waitForTimeout(pause);
    await this.recorder.stop();
  }

  /**
   * Select a cell with the pointer, in command mode.
   */
  async select(index: number): Promise<void> {
    await this.pointer.click(this.cell(index).locator('.jp-InputPrompt'));
  }

  cell(index: number): Locator {
    return this.page.locator('.jp-Notebook .jp-Cell').nth(index);
  }

  /**
   * Run the selected cell with Shift+Enter, and wait for it.
   */
  async run(index: number, pause = 1500): Promise<void> {
    await this.page.keyboard.press('Shift+Enter');
    await expect(this.cell(index).locator('.jp-InputPrompt')).toHaveText(
      /\[\d+\]:/,
      {
        timeout: 60000
      }
    );
    await this.page.waitForTimeout(pause);
  }

  /**
   * Run several cells, one after the other.
   */
  async runAll(pauses: number[], first = 0): Promise<void> {
    for (let i = 0; i < pauses.length; i++) {
      await this.run(first + i, pauses[i]);
    }
  }

  /**
   * Type some code like a person would.
   */
  async type(text: string, delay = 70): Promise<void> {
    await this.page.keyboard.type(text, { delay });
  }

  protected start: { x: number; y: number };
  protected recorder: Recorder;
}
