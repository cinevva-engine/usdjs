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
    /** Parsed numeric value for `kind === 'number'` (fast path). */
    numberValue?: number;
    /** Optional source span for tokens (used when `emitNumberStrings` is false). */
    spanStart?: number;
    spanEnd?: number;
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
    /**
     * If false, number tokens avoid allocating substrings; `token.value` will be empty and
     * the token will provide `numberValue` + `spanStart/spanEnd`.
     *
     * Default: true (preserve legacy behavior).
     */
    emitNumberStrings?: boolean;
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

    /**
     * Access a slice of the original source. (Allocates.)
     * Intended for rare fallback/debug paths.
     */
    slice(start: number, end: number): string {
        return this.src.slice(start, end);
    }

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
            const { start, end, numberValue } = this.readNumberTokenFast();
            const emitStr = this.opts.emitNumberStrings !== false;
            const value = emitStr ? this.src.slice(start, end) : '';
            return { kind: 'number', value, numberValue, spanStart: start, spanEnd: end, offset, line, col };
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
        const src = this.src;
        const len = src.length;
        while (this.i < len) {
            const ch = src[this.i]!;

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
                // Fast-path: jump to end-of-line without per-char advancing.
                const start = this.i;
                const nl = src.indexOf('\n', start);
                if (nl === -1) {
                    this.col += (len - start);
                    this.i = len;
                    return;
                }
                this.col += (nl - start);
                this.i = nl;
                continue;
            }

            break;
        }
    }

    private readString(): string {
        const src = this.src;
        const len = src.length;
        // supports "..." and triple-quoted """..."""
        if (src.slice(this.i, this.i + 3) === '"""') {
            const start = this.i;
            const contentStart = start + 3;
            const end = src.indexOf('"""', contentStart);
            if (end === -1) throw new Error(`Unterminated triple-quoted string at ${this.line}:${this.col}`);
            this.advance(end + 3 - start);
            return src.slice(contentStart, end);
        }

        // normal quoted string, minimal escapes
        this.advance(1); // consume opening quote
        const startContent = this.i;
        let startSlice = startContent;
        let parts: string[] | null = null;

        while (this.i < len) {
            const ch = src[this.i]!;
            if (ch === '"') {
                const end = this.i;
                this.advance(1);
                if (!parts) return src.slice(startContent, end);
                if (end > startSlice) parts.push(src.slice(startSlice, end));
                return parts.join('');
            }
            if (ch === '\\') {
                const next = src[this.i + 1] ?? '';
                if (next === '"' || next === '\\' || next === 'n' || next === 't' || next === 'r') {
                    if (!parts) parts = [];
                    if (this.i > startSlice) parts.push(src.slice(startSlice, this.i));
                    parts.push(next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next);
                    this.advance(2);
                    startSlice = this.i;
                    continue;
                }
            }
            this.advance(1);
        }
        throw new Error(`Unterminated string at ${this.line}:${this.col}`);
    }

    private readAtPath(): string {
        const src = this.src;
        const start = this.i;
        const end = src.indexOf('@', start + 1);
        if (end === -1) throw new Error(`Unterminated @path@ at ${this.line}:${this.col}`);
        this.advance(end + 1 - start);
        return src.slice(start + 1, end);
    }

    private readSdfPath(): string {
        const src = this.src;
        const start = this.i;
        const end = src.indexOf('>', start + 1);
        if (end === -1) throw new Error(`Unterminated <sdfpath> at ${this.line}:${this.col}`);
        this.advance(end + 1 - start);
        // manual trim (avoid `.trim()` allocation)
        let a = start + 1;
        let b = end;
        while (a < b) {
            const c = src.charCodeAt(a);
            if (c === 32 || c === 9 || c === 13 || c === 10) a++;
            else break;
        }
        while (b > a) {
            const c = src.charCodeAt(b - 1);
            if (c === 32 || c === 9 || c === 13 || c === 10) b--;
            else break;
        }
        return src.slice(a, b);
    }

    private readNumberTokenFast(): { start: number; end: number; numberValue: number } {
        // Parse number token in a single pass WITHOUT calling advance() per character.
        // Assumes no newlines inside number literals (true for USDA numeric tokens).
        const src = this.src;
        const len = src.length;
        const start = this.i;
        let i = start;

        // sign
        let sign = 1;
        const c0 = src.charCodeAt(i);
        if (c0 === 45 /* - */) { sign = -1; i++; }
        else if (c0 === 43 /* + */) { i++; }

        // integer part
        let intPart = 0;
        let sawDigit = false;
        while (i < len) {
            const c = src.charCodeAt(i);
            if (c >= 48 && c <= 57) {
                sawDigit = true;
                intPart = intPart * 10 + (c - 48);
                i++;
            } else break;
        }
        if (!sawDigit) {
            // malformed; consume 1 char to avoid infinite loops
            this.i = Math.min(len, start + 1);
            this.col += (this.i - start);
            return { start, end: this.i, numberValue: NaN };
        }

        // fraction
        let fracPart = 0;
        let fracDiv = 1;
        if (i < len && src.charCodeAt(i) === 46 /* . */) {
            i++;
            while (i < len) {
                const c = src.charCodeAt(i);
                if (c >= 48 && c <= 57) {
                    fracPart = fracPart * 10 + (c - 48);
                    fracDiv *= 10;
                    i++;
                } else break;
            }
        }

        let val = intPart + (fracDiv !== 1 ? (fracPart / fracDiv) : 0);

        // exponent (optional)
        if (i < len) {
            const ce = src.charCodeAt(i);
            if (ce === 101 /* e */ || ce === 69 /* E */) {
                i++;
                let expSign = 1;
                if (i < len) {
                    const cs = src.charCodeAt(i);
                    if (cs === 45 /* - */) { expSign = -1; i++; }
                    else if (cs === 43 /* + */) { i++; }
                }
                let exp = 0;
                let sawExp = false;
                while (i < len) {
                    const c = src.charCodeAt(i);
                    if (c >= 48 && c <= 57) {
                        sawExp = true;
                        exp = exp * 10 + (c - 48);
                        i++;
                    } else break;
                }
                if (sawExp) val = val * Math.pow(10, expSign * exp);
            }
        }

        // Commit consume
        this.i = i;
        this.col += (i - start);
        return { start, end: i, numberValue: sign * val };
    }

    private readIdentifier(): string {
        const src = this.src;
        const len = src.length;
        const start = this.i;
        this.advance(1);
        while (this.i < len && this.isIdentContinueCode(src.charCodeAt(this.i))) this.advance(1);
        return src.slice(start, this.i);
    }

    private readPunct(): string {
        // USDA has multi-char punctuation tokens like '[]', '()', '{}', '::', '=>' etc.
        // Start minimal and extend as parser needs.
        const ch = this.src[this.i]!;
        this.advance(1);
        return ch;
    }

    private advance(n: number): void {
        if (n <= 0) return;
        if (n === 1) {
            const ch = this.src[this.i]!;
            this.i++;
            if (ch === '\n') {
                this.line++;
                this.col = 1;
            } else {
                this.col++;
            }
            return;
        }
        const src = this.src;
        const start = this.i;
        const end = Math.min(src.length, start + n);
        if (end <= start) return;

        let nlCount = 0;
        let lastNL = -1;
        let idx = src.indexOf('\n', start);
        while (idx !== -1 && idx < end) {
            nlCount++;
            lastNL = idx;
            idx = src.indexOf('\n', idx + 1);
        }
        this.i = end;
        if (nlCount === 0) {
            this.col += (end - start);
            return;
        }
        this.line += nlCount;
        this.col = end - lastNL;
    }

    private isIdentStart(ch: string): boolean {
        return this.isIdentStartCode(ch.charCodeAt(0));
    }

    private isIdentContinue(ch: string): boolean {
        return this.isIdentContinueCode(ch.charCodeAt(0));
    }

    private isNumberStart(ch: string): boolean {
        const c = ch.charCodeAt(0);
        return (c >= 48 && c <= 57) || c === 45 /* - */ || c === 43 /* + */;
    }

    private isIdentStartCode(c: number): boolean {
        return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    }

    private isIdentContinueCode(c: number): boolean {
        return this.isIdentStartCode(c) || (c >= 48 && c <= 57) || c === 58 /* : */ || c === 95 /* _ */;
    }
}

/**
 * Parse a USDA number in `src[start:end]` without allocating a substring.
 *
 * Supported grammar matches `readNumberSpan()`:
 *   [+-]? DIGITS ( '.' DIGITS )? ( [eE] [+-]? DIGITS )?
 */
// (No standalone parseNumberSpan needed anymore; number parsing is fused into readNumberTokenFast()).


