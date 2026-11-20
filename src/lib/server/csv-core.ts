// The one CSV reader and writer. Pure: no I/O, no SvelteKit, no $env, so the
// export endpoint, scripts/export-members.ts and the import all run this code.
// Export and import sharing it is what makes the round trip a property rather
// than a coincidence: two implementations disagree at the edges (a quote inside
// a multiline cell, a leading apostrophe), and the edges are where the data is.
//
// The round-trip contract: parseCsv(formatCsv(rows)) returns `rows` unchanged,
// for any strings at all. The member export builds on it, so importing an
// unmodified full export produces a zero-row diff.

// Excel reads a UTF-8 CSV without one as the local code page and mangles every
// non-ASCII name in the file.
export const BOM = '\uFEFF';

// RFC 4180 separates records with CRLF. Line breaks inside a cell are kept as
// they were, inside quotes.
const RECORD_SEPARATOR = '\r\n';

// A cell Excel or Sheets would evaluate as a formula gets one apostrophe in
// front. The apostrophe itself is on the list so that the transformation can be
// undone exactly: a value that already starts with one gets a second, and
// stripping one on the way back in restores it whatever followed.
const FORMULA_LEAD = /^[=+\-@\t\r']/;

export function guardCell(value: string): string {
	return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

// Strips exactly one leading apostrophe, the inverse of guardCell.
export function unguardCell(value: string): string {
	return value.startsWith("'") ? value.slice(1) : value;
}

function quoteCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

// A BOM, then one CRLF-terminated record per row, every cell guarded and quoted
// where RFC 4180 needs it.
export function formatCsv(rows: readonly (readonly string[])[]): string {
	return (
		BOM +
		rows.map((r) => r.map((c) => quoteCell(guardCell(c))).join(',') + RECORD_SEPARATOR).join('')
	);
}

export class CsvError extends Error {
	constructor(
		message: string,
		readonly line: number
	) {
		super(`line ${line}: ${message}`);
		this.name = 'CsvError';
	}
}

// The separators an import accepts. Excel in a locale whose decimal mark is a
// comma separates with `;`, and its "Unicode Text" format writes tabs.
export type Delimiter = ',' | ';' | '\t';

export type CsvRecord = {
	cells: string[];
	// The file line the record starts on, 1-based. It runs ahead of the record's
	// position whenever an earlier cell held a line break.
	line: number;
	// The physical line held nothing: no separator, no quotes, no space. Its one
	// cell is '' just as a quoted "" or a blank single-column cell is, and only
	// this flag tells them apart.
	empty: boolean;
};

// RFC 4180 with the line endings real files arrive with: CRLF, LF or a bare CR
// ends a record outside quotes. A leading BOM is dropped and every cell is
// unguarded. Malformed quoting throws with the line it is on rather than
// guessing, because a guess moves a value into the neighboring column.
export function parseCsv(text: string, delimiter: Delimiter = ','): string[][] {
	return parseCsvRecords(text, delimiter).map((r) => r.cells);
}

export function parseCsvRecords(text: string, delimiter: Delimiter = ','): CsvRecord[] {
	const src = text.startsWith(BOM) ? text.slice(BOM.length) : text;
	const rows: CsvRecord[] = [];
	let row: string[] = [];
	let rowLine = 1;
	let cell = '';
	// The current cell was quoted and its closing quote has been read, so only a
	// separator may follow.
	let closed = false;
	let line = 1;
	let i = 0;

	const endCell = () => {
		row.push(unguardCell(cell));
		cell = '';
		closed = false;
	};

	while (i < src.length) {
		const ch = src[i];
		if (ch === delimiter) {
			endCell();
			i++;
		} else if (ch === '\r' || ch === '\n') {
			const empty = row.length === 0 && cell === '' && !closed;
			endCell();
			rows.push({ cells: row, line: rowLine, empty });
			row = [];
			i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
			line++;
			rowLine = line;
		} else if (closed) {
			throw new CsvError('text after a closing quote', line);
		} else if (ch === '"') {
			if (cell !== '') throw new CsvError('a quote inside an unquoted cell', line);
			const start = line;
			i++;
			for (;;) {
				if (i >= src.length) throw new CsvError('a quoted cell is never closed', start);
				const q = src[i];
				if (q === '"' && src[i + 1] === '"') {
					cell += '"';
					i += 2;
				} else if (q === '"') {
					i++;
					break;
				} else {
					if (q === '\n' || (q === '\r' && src[i + 1] !== '\n')) line++;
					cell += q;
					i++;
				}
			}
			closed = true;
		} else {
			cell += ch;
			i++;
		}
	}
	// A file that ends without a final line break still has a last record.
	if (cell !== '' || closed || row.length > 0) {
		endCell();
		rows.push({ cells: row, line: rowLine, empty: false });
	}
	return rows;
}
