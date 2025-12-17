export type UsdaTokenKind =
    | 'identifier'
    | 'string'
    | 'number'
    | 'path'
    | 'sdfpath'
    | 'punct'
    | 'newline'
    | 'eof';

export interface UsdaToken {
    kind: UsdaTokenKind;
    value: string;
    offset: number;
    line: number;
    col: number;
}

export interface UsdaLexerOptions {
    /**
     * If true, emit newline tokens.
     * Many parsers don't need them; they are useful for preserving formatting.
     */
    emitNewlines?: boolean;
}

/**
 * Streaming-ish lexer for USDA.
 *
 * This is intentionally a foundation skeleton. We'll expand token kinds and
 * edge-case handling as the parser and round-trip goals mature.
 */
export class UsdaLexer {
    private i = 0;
    private line = 1;
    private col = 1;

    constructor(
        private readonly src: string,
        private readonly opts: UsdaLexerOptions = {}
    ) { }

    next(): UsdaToken {
        this.skipWhitespaceAndComments();

        const offset = this.i;
        const line = this.line;
        const col = this.col;

        if (this.i >= this.src.length) return { kind: 'eof', value: '', offset, line, col };

        const ch = this.src[this.i]!;

        // Newline tokenization (optional)
        if (ch === '\n') {
            this.advance(1);
            return { kind: 'newline', value: '\n', offset, line, col };
        }

        // Strings: "..."
        if (ch === '"') {
            const value = this.readString();
            return { kind: 'string', value, offset, line, col };
        }

        // Paths: @...@
        if (ch === '@') {
            const value = this.readAtPath();
            return { kind: 'path', value, offset, line, col };
        }

        // SdfPaths: </Prim/Path> or <.property> etc (foundation: read until '>')
        if (ch === '<') {
            const value = this.readSdfPath();
            return { kind: 'sdfpath', value, offset, line, col };
        }

        // Numbers: simple subset for now
        if (this.isNumberStart(ch)) {
            const value = this.readNumber();
            return { kind: 'number', value, offset, line, col };
        }

        // Identifiers/tokens
        if (this.isIdentStart(ch)) {
            const value = this.readIdentifier();
            return { kind: 'identifier', value, offset, line, col };
        }

        // Punctuation
        const punct = this.readPunct();
        return { kind: 'punct', value: punct, offset, line, col };
    }

    private skipWhitespaceAndComments(): void {
        while (this.i < this.src.length) {
            const ch = this.src[this.i]!;

            // Newlines: either emit token or skip
            if (ch === '\n') {
                if (this.opts.emitNewlines) return;
                this.advance(1);
                continue;
            }

            // Whitespace
            if (ch === ' ' || ch === '\t' || ch === '\r') {
                this.advance(1);
                continue;
            }

            // Comments: '#' to end-of-line
            if (ch === '#') {
                while (this.i < this.src.length && this.src[this.i] !== '\n') this.advance(1);
                continue;
            }

            break;
        }
    }

    private readString(): string {
        // supports "..." and triple-quoted """..."""
        if (this.src.slice(this.i, this.i + 3) === '"""') {
            this.advance(3);
            let out = '';
            while (this.i < this.src.length) {
                if (this.src.slice(this.i, this.i + 3) === '"""') {
                    this.advance(3);
                    return out;
                }
                out += this.src[this.i]!;
                this.advance(1);
            }
            throw new Error(`Unterminated triple-quoted string at ${this.line}:${this.col}`);
        }

        // assumes current is '"'
        this.advance(1);
        let out = '';
        while (this.i < this.src.length) {
            const ch = this.src[this.i]!;
            if (ch === '"') {
                this.advance(1);
                return out;
            }
            if (ch === '\\') {
                // minimal escapes
                const next = this.src[this.i + 1] ?? '';
                if (next === '"' || next === '\\' || next === 'n' || next === 't' || next === 'r') {
                    out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
                    this.advance(2);
                    continue;
                }
            }
            out += ch;
            this.advance(1);
        }
        throw new Error(`Unterminated string at ${this.line}:${this.col}`);
    }

    private readAtPath(): string {
        // @asset/path@ form
        this.advance(1);
        let out = '';
        while (this.i < this.src.length) {
            const ch = this.src[this.i]!;
            if (ch === '@') {
                this.advance(1);
                return out;
            }
            out += ch;
            this.advance(1);
        }
        throw new Error(`Unterminated @path@ at ${this.line}:${this.col}`);
    }

    private readSdfPath(): string {
        // <...> form; return inside without angle brackets
        this.advance(1);
        let out = '';
        while (this.i < this.src.length) {
            const ch = this.src[this.i]!;
            if (ch === '>') {
                this.advance(1);
                return out.trim();
            }
            out += ch;
            this.advance(1);
        }
        throw new Error(`Unterminated <sdfpath> at ${this.line}:${this.col}`);
    }

    private readNumber(): string {
        const start = this.i;
        if (this.src[this.i] === '+' || this.src[this.i] === '-') this.advance(1);
        while (this.i < this.src.length && /[0-9]/.test(this.src[this.i]!)) this.advance(1);
        if (this.src[this.i] === '.') {
            this.advance(1);
            while (this.i < this.src.length && /[0-9]/.test(this.src[this.i]!)) this.advance(1);
        }
        // exponent
        const e = this.src[this.i];
        if (e === 'e' || e === 'E') {
            this.advance(1);
            const s = this.src[this.i];
            if (s === '+' || s === '-') this.advance(1);
            while (this.i < this.src.length && /[0-9]/.test(this.src[this.i]!)) this.advance(1);
        }
        return this.src.slice(start, this.i);
    }

    private readIdentifier(): string {
        const start = this.i;
        this.advance(1);
        while (this.i < this.src.length && this.isIdentContinue(this.src[this.i]!)) this.advance(1);
        return this.src.slice(start, this.i);
    }

    private readPunct(): string {
        // USDA has multi-char punctuation tokens like '[]', '()', '{}', '::', '=>' etc.
        // Start minimal and extend as parser needs.
        const ch = this.src[this.i]!;
        this.advance(1);
        return ch;
    }

    private advance(n: number): void {
        for (let k = 0; k < n; k++) {
            const ch = this.src[this.i]!;
            this.i++;
            if (ch === '\n') {
                this.line++;
                this.col = 1;
            } else {
                this.col++;
            }
        }
    }

    private isIdentStart(ch: string): boolean {
        return /[A-Za-z_]/.test(ch);
    }

    private isIdentContinue(ch: string): boolean {
        return /[A-Za-z0-9_:]/.test(ch);
    }

    private isNumberStart(ch: string): boolean {
        return /[0-9]/.test(ch) || ch === '-' || ch === '+';
    }
}


