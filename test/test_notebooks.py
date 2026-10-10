#############################################################################
# Copyright (c) 2026, Jeremy Tuloup                                         #
#                                                                           #
# Distributed under the terms of the BSD 3-Clause License.                  #
#                                                                           #
# The full license is in the file LICENSE, distributed with this software.  #
#############################################################################

"""Executes the example notebooks.

The cells tagged "interactive" need a person (to answer a prompt, or to
interrupt the kernel) and are skipped. The cells tagged "raises-exception"
are expected to fail.
"""

from pathlib import Path

import nbformat
import pytest
from nbclient import NotebookClient

NOTEBOOKS = Path(__file__).parent.parent / "notebooks"


@pytest.mark.parametrize("path", sorted(NOTEBOOKS.glob("*.ipynb")), ids=lambda path: path.name)
def test_notebook(path):
    notebook = nbformat.read(path, as_version=4)
    notebook.cells = [
        cell for cell in notebook.cells if "interactive" not in cell.metadata.get("tags", [])
    ]
    client = NotebookClient(notebook, kernel_name="xquickjs", timeout=60, resources={"metadata": {"path": str(NOTEBOOKS)}})
    client.execute()

    for cell in notebook.cells:
        if cell.cell_type != "code":
            continue
        errors = [output for output in cell.outputs if output.output_type == "error"]
        if "raises-exception" in cell.metadata.get("tags", []):
            assert errors, f"expected an error in:\n{cell.source}"
        else:
            assert not errors, f"unexpected error in:\n{cell.source}\n\n" + "\n".join(errors[0].traceback)
