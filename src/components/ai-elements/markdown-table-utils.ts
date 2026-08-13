interface TableData {
  headers: string[];
  rows: string[][];
}

export const extractTableDataFromElement = (
  tableElement: HTMLElement,
): TableData => ({
  headers: Array.from(tableElement.querySelectorAll("thead th"), (cell) =>
    cell.textContent?.trim() ?? "",
  ),
  rows: Array.from(tableElement.querySelectorAll("tbody tr"), (row) =>
    Array.from(row.querySelectorAll("td"), (cell) =>
      cell.textContent?.trim() ?? "",
    ),
  ),
});

const escapeDelimitedCell = (cell: string, delimiter: string) => {
  if (
    cell.includes(delimiter) ||
    cell.includes('"') ||
    cell.includes("\n") ||
    cell.includes("\r")
  ) {
    return `"${cell.replace(/"/g, '""')}"`;
  }

  return cell;
};

const tableDataToDelimited = (data: TableData, delimiter: string) =>
  [data.headers, ...data.rows]
    .map((row) =>
      row.map((cell) => escapeDelimitedCell(cell, delimiter)).join(delimiter),
    )
    .join("\n");

export const tableDataToCSV = (data: TableData) =>
  tableDataToDelimited(data, ",");

export const tableDataToTSV = (data: TableData) =>
  tableDataToDelimited(data, "\t");

const escapeMarkdownCell = (cell: string) =>
  cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export const tableDataToMarkdown = (data: TableData) => {
  const columnCount = Math.max(
    data.headers.length,
    ...data.rows.map((row) => row.length),
  );
  if (columnCount === 0) {
    return "";
  }

  const normalizeRow = (row: string[]) =>
    Array.from({ length: columnCount }, (_, index) =>
      escapeMarkdownCell(row[index] ?? ""),
    );
  const formatRow = (row: string[]) => `| ${normalizeRow(row).join(" | ")} |`;
  const headers = data.headers.length > 0 ? data.headers : Array(columnCount).fill("");

  return [
    formatRow(headers),
    `| ${Array(columnCount).fill("---").join(" | ")} |`,
    ...data.rows.map(formatRow),
  ].join("\n");
};
