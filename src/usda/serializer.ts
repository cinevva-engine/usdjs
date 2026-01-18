/**
 * USDA Serializer - Writes SdfLayer to USDA text format.
 * 
 * Design goals:
 * 1. Round-trip preservation: Parse → Serialize → Parse should produce equivalent data
 * 2. Unsupported primitives: Unknown metadata/properties are preserved and written back
 * 3. Human-readable output: Proper indentation and formatting
 * 4. Compatibility: Output should be parseable by Pixar's usdcat/usdview
 */

import { SdfLayer, type SdfPrimSpec, type SdfPropertySpec, type SdfValue, type SdfVariantSetSpec } from '../sdf/layer.js';

export interface UsdaSerializeOptions {
    /** Number of spaces per indent level (default: 4) */
    indentSize?: number;
    /** Include comment header with timestamp (default: false) */
    includeHeader?: boolean;
    /** Pretty-print arrays with newlines for large arrays (default: true) */
    prettyArrays?: boolean;
    /** Threshold for pretty-printing arrays (default: 8 elements) */
    prettyArrayThreshold?: number;
}

const DEFAULT_OPTIONS: Required<UsdaSerializeOptions> = {
    indentSize: 4,
    includeHeader: false,
    prettyArrays: true,
    prettyArrayThreshold: 8,
};

/**
 * Serialize an SdfLayer to USDA text format.
 */
export function serializeLayerToUsda(layer: SdfLayer, opts: UsdaSerializeOptions = {}): string {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const writer = new UsdaWriter(options);
    return writer.serializeLayer(layer);
}

/**
 * Serialize a single prim to USDA text (useful for debugging/inspection).
 */
export function serializePrimToUsda(prim: SdfPrimSpec, opts: UsdaSerializeOptions = {}): string {
    const options = { ...DEFAULT_OPTIONS, ...opts };
    const writer = new UsdaWriter(options);
    return writer.serializePrim(prim, 0);
}

class UsdaWriter {
    private lines: string[] = [];
    private readonly indentStr: string;

    constructor(private readonly options: Required<UsdaSerializeOptions>) {
        this.indentStr = ' '.repeat(options.indentSize);
    }

    serializeLayer(layer: SdfLayer): string {
        this.lines = [];

        // USDA header
        this.lines.push('#usda 1.0');

        // Layer metadata
        const metaKeys = Object.keys(layer.metadata ?? {});
        if (metaKeys.length > 0) {
            this.lines.push('(');
            this.writeMetadataBlock(layer.metadata, 1);
            this.lines.push(')');
        }
        this.lines.push('');

        // Root prims
        const root = layer.root;
        if (root.children) {
            for (const child of root.children.values()) {
                this.lines.push(this.serializePrim(child, 0));
                this.lines.push('');
            }
        }

        return this.lines.join('\n');
    }

    serializePrim(prim: SdfPrimSpec, depth: number): string {
        const indent = this.indent(depth);
        const lines: string[] = [];

        // Prim definition line
        const specifier = prim.specifier ?? 'def';
        const typeName = prim.typeName ?? '';
        const primName = this.extractPrimName(prim);
        
        let defLine = `${indent}${specifier}`;
        if (typeName) {
            defLine += ` ${typeName}`;
        }
        defLine += ` "${primName}"`;

        // Prim metadata
        const hasMeta = prim.metadata && Object.keys(prim.metadata).length > 0;
        const hasVariantSets = prim.variantSets && prim.variantSets.size > 0;
        
        if (hasMeta || hasVariantSets) {
            defLine += ' (';
            lines.push(defLine);
            
            if (hasMeta) {
                this.writeMetadataBlockToLines(lines, prim.metadata!, depth + 1);
            }
            
            // Write variantSets declaration in metadata if we have variant set definitions
            // but only if not already declared via metadata (either as listOp or plain array)
            if (hasVariantSets) {
                const hasVsInMeta = prim.metadata && 'variantSets' in prim.metadata;
                if (!hasVsInMeta) {
                    const setNames = Array.from(prim.variantSets!.keys());
                    const setsLine = `${this.indent(depth + 1)}variantSets = [${setNames.map(n => `"${n}"`).join(', ')}]`;
                    lines.push(setsLine);
                }
            }
            
            lines.push(`${indent})`);
        } else {
            lines.push(defLine);
        }

        lines.push(`${indent}{`);

        // Properties
        if (prim.properties && prim.properties.size > 0) {
            // Check for propertyOrder metadata
            const propOrder = (prim.metadata as any)?.propertyOrder;
            let orderedProps: [string, SdfPropertySpec][];
            
            if (propOrder && typeof propOrder === 'object' && propOrder.type === 'array') {
                // Use authored order
                const orderList = (propOrder.value as any[])
                    .map((v: any) => typeof v === 'string' ? v : (v?.value ?? ''))
                    .filter((s: string) => s);
                const seen = new Set<string>();
                orderedProps = [];
                for (const name of orderList) {
                    const prop = prim.properties.get(name);
                    if (prop) {
                        orderedProps.push([name, prop]);
                        seen.add(name);
                    }
                }
                // Add any remaining props not in order
                for (const [name, prop] of prim.properties) {
                    if (!seen.has(name)) {
                        orderedProps.push([name, prop]);
                    }
                }
            } else {
                orderedProps = Array.from(prim.properties.entries());
            }

            for (const [name, prop] of orderedProps) {
                const propLine = this.serializeProperty(name, prop, depth + 1);
                if (propLine) lines.push(propLine);
            }
        }

        // Variant sets (full definition)
        if (prim.variantSets && prim.variantSets.size > 0) {
            for (const [setName, variantSet] of prim.variantSets) {
                lines.push('');
                lines.push(this.serializeVariantSet(setName, variantSet, depth + 1));
            }
        }

        // Children
        if (prim.children && prim.children.size > 0) {
            for (const child of prim.children.values()) {
                lines.push('');
                lines.push(this.serializePrim(child, depth + 1));
            }
        }

        lines.push(`${indent}}`);

        return lines.join('\n');
    }

    private serializeProperty(name: string, prop: SdfPropertySpec, depth: number): string {
        const indent = this.indent(depth);
        const lines: string[] = [];
        
        // Build property qualifiers
        const qualifiers: string[] = [];
        if (prop.metadata?.custom === true) {
            qualifiers.push('custom');
        }
        const qualifier = prop.metadata?.qualifier;
        if (qualifier && typeof qualifier === 'object' && (qualifier as any).type === 'token') {
            const q = (qualifier as any).value;
            if (q === 'uniform' || q === 'varying') {
                qualifiers.push(q);
            }
        }
        
        const qualifierStr = qualifiers.length > 0 ? qualifiers.join(' ') + ' ' : '';
        const typeName = prop.typeName ?? 'unknown';
        
        // Handle .connect and .timeSamples field names
        const dotIdx = name.indexOf('.');
        const baseName = dotIdx > 0 ? name.slice(0, dotIdx) : name;
        const fieldName = dotIdx > 0 ? name.slice(dotIdx + 1) : null;
        
        // Property with timeSamples
        if (prop.timeSamples && prop.timeSamples.size > 0) {
            const tsLines = this.serializeTimeSamples(prop.timeSamples, depth);
            const propMeta = this.serializePropertyMetadata(prop, depth);
            lines.push(`${indent}${qualifierStr}${typeName} ${baseName}.timeSamples = {`);
            lines.push(tsLines);
            lines.push(`${indent}}${propMeta}`);
            return lines.join('\n');
        }
        
        // Property with default value
        if (prop.defaultValue !== undefined) {
            const valueStr = this.serializeValue(prop.defaultValue, depth + 1);
            const propMeta = this.serializePropertyMetadata(prop, depth);
            const nameWithField = fieldName ? `${baseName}.${fieldName}` : baseName;
            return `${indent}${qualifierStr}${typeName} ${nameWithField} = ${valueStr}${propMeta}`;
        }
        
        // Declaration without value
        const propMeta = this.serializePropertyMetadata(prop, depth);
        const nameWithField = fieldName ? `${baseName}.${fieldName}` : baseName;
        return `${indent}${qualifierStr}${typeName} ${nameWithField}${propMeta}`;
    }

    private serializePropertyMetadata(prop: SdfPropertySpec, depth: number): string {
        if (!prop.metadata) return '';
        
        // Filter out internal metadata we handle specially
        const skipKeys = new Set(['custom', 'qualifier']);
        const metaEntries = Object.entries(prop.metadata).filter(([k]) => !skipKeys.has(k));
        
        if (metaEntries.length === 0) return '';
        
        const metaLines: string[] = [];
        for (const [key, value] of metaEntries) {
            metaLines.push(`${key} = ${this.serializeValue(value, 0)}`);
        }
        
        return ` (${metaLines.join(', ')})`;
    }

    private serializeTimeSamples(samples: Map<number, SdfValue>, depth: number): string {
        const indent = this.indent(depth + 1);
        const lines: string[] = [];
        
        // Sort by time
        const sortedTimes = Array.from(samples.keys()).sort((a, b) => a - b);
        
        for (const time of sortedTimes) {
            const value = samples.get(time)!;
            const valueStr = this.serializeValue(value, depth + 2);
            lines.push(`${indent}${this.formatNumber(time)}: ${valueStr},`);
        }
        
        return lines.join('\n');
    }

    private serializeVariantSet(setName: string, variantSet: SdfVariantSetSpec, depth: number): string {
        const indent = this.indent(depth);
        const lines: string[] = [];
        
        lines.push(`${indent}variantSet "${setName}" = {`);
        
        for (const [variantName, variantPrim] of variantSet.variants) {
            lines.push(`${this.indent(depth + 1)}"${variantName}" {`);
            
            // Properties inside variant
            if (variantPrim.properties && variantPrim.properties.size > 0) {
                for (const [propName, prop] of variantPrim.properties) {
                    const propLine = this.serializeProperty(propName, prop, depth + 2);
                    if (propLine) lines.push(propLine);
                }
            }
            
            // Nested variant sets
            if (variantPrim.variantSets && variantPrim.variantSets.size > 0) {
                for (const [nestedSetName, nestedSet] of variantPrim.variantSets) {
                    lines.push('');
                    lines.push(this.serializeVariantSet(nestedSetName, nestedSet, depth + 2));
                }
            }
            
            // Children inside variant
            if (variantPrim.children && variantPrim.children.size > 0) {
                for (const child of variantPrim.children.values()) {
                    lines.push('');
                    lines.push(this.serializePrim(child, depth + 2));
                }
            }
            
            lines.push(`${this.indent(depth + 1)}}`);
        }
        
        lines.push(`${indent}}`);
        
        return lines.join('\n');
    }

    private serializeValue(value: SdfValue, depth: number): string {
        if (value === null) return 'None';
        if (value === true) return 'true';
        if (value === false) return 'false';
        if (typeof value === 'number') return this.formatNumber(value);
        if (typeof value === 'string') return this.escapeString(value);
        
        if (typeof value === 'object') {
            const v = value as any;
            
            // Token
            if (v.type === 'token') {
                // Tokens can be written as quoted strings or bare identifiers
                // Use quoted for safety
                return `"${this.escapeStringContent(v.value)}"`;
            }
            
            // Asset path
            if (v.type === 'asset') {
                return `@${v.value}@`;
            }
            
            // SdfPath
            if (v.type === 'sdfpath') {
                return `<${v.value}>`;
            }
            
            // Reference (with optional target path and args)
            if (v.type === 'reference') {
                let result = `@${v.assetPath}@`;
                if (v.targetPath) {
                    result += `<${v.targetPath}>`;
                }
                // Handle offset/scale args
                const args: string[] = [];
                if (typeof v.offset === 'number') {
                    args.push(`offset = ${this.formatNumber(v.offset)}`);
                }
                if (typeof v.scale === 'number') {
                    args.push(`scale = ${this.formatNumber(v.scale)}`);
                }
                if (args.length > 0) {
                    result += ` (${args.join(', ')})`;
                }
                return result;
            }
            
            // Vectors (vec2f, vec3f, vec4f)
            if (v.type === 'vec2f' || v.type === 'vec3f' || v.type === 'vec4f') {
                const nums = v.value as number[];
                return `(${nums.map(n => this.formatNumber(n)).join(', ')})`;
            }
            
            // Matrix4d
            if (v.type === 'matrix4d') {
                const nums = v.value as number[];
                // Write as nested rows
                const rows: string[] = [];
                for (let i = 0; i < 4; i++) {
                    const row = nums.slice(i * 4, i * 4 + 4);
                    rows.push(`(${row.map(n => this.formatNumber(n)).join(', ')})`);
                }
                return `(${rows.join(', ')})`;
            }
            
            // TypedArray (packed numeric data)
            if (v.type === 'typedArray') {
                const elementType = v.elementType as string;
                const arr = v.value as Float32Array | Float64Array | Int32Array | Uint32Array;
                
                // Matrix arrays
                if (elementType === 'matrix4d' || elementType === 'matrix4f' || elementType === 'matrix4h') {
                    return this.serializeMatrix4Array(arr);
                }
                
                // Quaternion scalar
                if (elementType === 'quatd' || elementType === 'quatf' || elementType === 'quath') {
                    if (arr.length === 4) {
                        return `(${Array.from(arr).map(n => this.formatNumber(n)).join(', ')})`;
                    }
                }
                
                // Tuple arrays (point3f[], texCoord2f[], etc.)
                const tupleSize = this.getTupleSizeForType(elementType);
                if (tupleSize > 1) {
                    return this.serializeTupleArray(arr, tupleSize, depth);
                }
                
                // Scalar arrays
                return this.serializeScalarArray(arr, depth);
            }
            
            // Tuple
            if (v.type === 'tuple') {
                const values = v.value as SdfValue[];
                return `(${values.map(vv => this.serializeValue(vv, depth)).join(', ')})`;
            }
            
            // Array
            if (v.type === 'array') {
                const values = v.value as SdfValue[];
                if (values.length === 0) return '[]';
                
                const shouldPretty = this.options.prettyArrays && 
                    values.length > this.options.prettyArrayThreshold;
                    
                if (shouldPretty) {
                    const indent = this.indent(depth + 1);
                    const closeIndent = this.indent(depth);
                    const items = values.map(vv => `${indent}${this.serializeValue(vv, depth + 1)},`);
                    return `[\n${items.join('\n')}\n${closeIndent}]`;
                }
                
                return `[${values.map(vv => this.serializeValue(vv, depth)).join(', ')}]`;
            }
            
            // Dict
            if (v.type === 'dict') {
                const dict = v.value as Record<string, SdfValue>;
                const entries = Object.entries(dict);
                
                if (entries.length === 0) return '{}';
                
                // Check if this is a listOp dict
                if ('op' in dict && 'value' in dict) {
                    const op = dict.op;
                    const opToken = typeof op === 'object' && (op as any).type === 'token' 
                        ? (op as any).value 
                        : String(op);
                    // Return just the inner value - listOp wrapping is handled at metadata level
                    return this.serializeValue(dict.value as SdfValue, depth);
                }
                
                const indent = this.indent(depth + 1);
                const closeIndent = this.indent(depth);
                const items = entries.map(([k, vv]) => {
                    // Keys might need quoting if they contain special chars
                    const keyStr = this.needsQuoting(k) ? `"${this.escapeStringContent(k)}"` : k;
                    return `${indent}${keyStr} = ${this.serializeValue(vv, depth + 1)}`;
                });
                return `{\n${items.join('\n')}\n${closeIndent}}`;
            }
            
            // Raw/opaque value - write verbatim for round-trip preservation
            if (v.type === 'raw') {
                return v.value;
            }
        }
        
        // Fallback for unknown types
        return `"${String(value)}"`;
    }

    private serializeScalarArray(arr: Float32Array | Float64Array | Int32Array | Uint32Array, depth: number): string {
        if (arr.length === 0) return '[]';
        
        const values = Array.from(arr);
        const shouldPretty = this.options.prettyArrays && 
            values.length > this.options.prettyArrayThreshold;
            
        if (shouldPretty) {
            const indent = this.indent(depth + 1);
            const closeIndent = this.indent(depth);
            // Group values for readability (8 per line)
            const groups: string[] = [];
            for (let i = 0; i < values.length; i += 8) {
                const group = values.slice(i, i + 8);
                groups.push(`${indent}${group.map(n => this.formatNumber(n)).join(', ')},`);
            }
            return `[\n${groups.join('\n')}\n${closeIndent}]`;
        }
        
        return `[${values.map(n => this.formatNumber(n)).join(', ')}]`;
    }

    private serializeTupleArray(arr: Float32Array | Float64Array | Int32Array | Uint32Array, tupleSize: number, depth: number): string {
        if (arr.length === 0) return '[]';
        
        const numTuples = Math.floor(arr.length / tupleSize);
        const tuples: string[] = [];
        
        for (let i = 0; i < numTuples; i++) {
            const start = i * tupleSize;
            const tuple: number[] = [];
            for (let j = 0; j < tupleSize; j++) {
                tuple.push(arr[start + j]);
            }
            tuples.push(`(${tuple.map(n => this.formatNumber(n)).join(', ')})`);
        }
        
        const shouldPretty = this.options.prettyArrays && 
            tuples.length > this.options.prettyArrayThreshold;
            
        if (shouldPretty) {
            const indent = this.indent(depth + 1);
            const closeIndent = this.indent(depth);
            const items = tuples.map(t => `${indent}${t},`);
            return `[\n${items.join('\n')}\n${closeIndent}]`;
        }
        
        return `[${tuples.join(', ')}]`;
    }

    private serializeMatrix4Array(arr: Float32Array | Float64Array | Int32Array | Uint32Array): string {
        if (arr.length === 0) return '[]';
        
        const numMatrices = Math.floor(arr.length / 16);
        const matrices: string[] = [];
        
        for (let m = 0; m < numMatrices; m++) {
            const start = m * 16;
            const rows: string[] = [];
            for (let r = 0; r < 4; r++) {
                const row: number[] = [];
                for (let c = 0; c < 4; c++) {
                    row.push(arr[start + r * 4 + c]);
                }
                rows.push(`(${row.map(n => this.formatNumber(n)).join(', ')})`);
            }
            matrices.push(`(${rows.join(', ')})`);
        }
        
        if (numMatrices === 1) {
            // Single matrix (scalar context)
            return matrices[0];
        }
        
        return `[${matrices.join(', ')}]`;
    }

    private writeMetadataBlock(metadata: Record<string, SdfValue>, depth: number): void {
        this.writeMetadataBlockToLines(this.lines, metadata, depth);
    }

    private writeMetadataBlockToLines(lines: string[], metadata: Record<string, SdfValue>, depth: number): void {
        const indent = this.indent(depth);
        
        // Handle known layer/prim metadata with proper formatting
        const orderedKeys = this.orderMetadataKeys(Object.keys(metadata));
        
        for (const key of orderedKeys) {
            const value = metadata[key];
            
            // Handle listOp-wrapped values
            if (value && typeof value === 'object' && (value as any).type === 'dict') {
                const dict = (value as any).value as Record<string, any>;
                if ('op' in dict && 'value' in dict) {
                    const op = dict.op;
                    const opToken = typeof op === 'object' && (op as any).type === 'token' 
                        ? (op as any).value 
                        : String(op);
                    const innerValue = this.serializeValue(dict.value as SdfValue, depth);
                    lines.push(`${indent}${opToken} ${key} = ${innerValue}`);
                    continue;
                }
            }
            
            const valueStr = this.serializeValue(value, depth);
            lines.push(`${indent}${key} = ${valueStr}`);
        }
    }

    private orderMetadataKeys(keys: string[]): string[] {
        // Order commonly-used metadata keys first for readability
        const priority = [
            'defaultPrim',
            'upAxis',
            'metersPerUnit',
            'startTimeCode',
            'endTimeCode',
            'framesPerSecond',
            'timeCodesPerSecond',
            'subLayers',
            'references',
            'payload',
            'inherits',
            'specializes',
            'variants',
            'variantSets',
            'apiSchemas',
            'kind',
            'instanceable',
            'active',
            'hidden',
            'documentation',
            'comment',
            'customData',
        ];
        
        const prioritySet = new Set(priority);
        const ordered: string[] = [];
        
        // Add priority keys in order
        for (const k of priority) {
            if (keys.includes(k)) {
                ordered.push(k);
            }
        }
        
        // Add remaining keys alphabetically
        const remaining = keys.filter(k => !prioritySet.has(k)).sort();
        ordered.push(...remaining);
        
        return ordered;
    }

    private getTupleSizeForType(elementType: string): number {
        // Check for explicit tuple types
        if (elementType.endsWith('2f') || elementType.endsWith('2d') || 
            elementType === 'float2' || elementType === 'double2' ||
            elementType === 'half2' || elementType === 'texCoord2f' ||
            elementType === 'texCoord2d') {
            return 2;
        }
        if (elementType.endsWith('3f') || elementType.endsWith('3d') ||
            elementType === 'float3' || elementType === 'double3' ||
            elementType === 'half3' || elementType === 'point3f' ||
            elementType === 'normal3f' || elementType === 'vector3f' ||
            elementType === 'color3f') {
            return 3;
        }
        if (elementType.endsWith('4f') || elementType.endsWith('4d') ||
            elementType === 'float4' || elementType === 'double4' ||
            elementType === 'half4' || elementType === 'color4f' ||
            elementType === 'quatf' || elementType === 'quatd') {
            return 4;
        }
        return 1;
    }

    private extractPrimName(prim: SdfPrimSpec): string {
        const path = prim.path?.primPath ?? '';
        const parts = path.split('/').filter(Boolean);
        return parts[parts.length - 1] ?? '';
    }

    private indent(depth: number): string {
        return this.indentStr.repeat(depth);
    }

    private formatNumber(n: number): string {
        if (!Number.isFinite(n)) {
            if (Number.isNaN(n)) return 'nan';
            return n > 0 ? 'inf' : '-inf';
        }
        
        // Check if it's an integer
        if (Number.isInteger(n) && Math.abs(n) < 1e15) {
            return String(n);
        }
        
        // Format as float with reasonable precision
        // USD typically uses enough precision to round-trip
        const str = n.toPrecision(9);
        
        // Clean up trailing zeros after decimal point
        if (str.includes('.') && !str.includes('e') && !str.includes('E')) {
            return str.replace(/\.?0+$/, '') || '0';
        }
        
        return str;
    }

    private escapeString(s: string): string {
        return `"${this.escapeStringContent(s)}"`;
    }

    private escapeStringContent(s: string): string {
        return s
            .replace(/\\/g, '\\\\')
            .replace(/"/g, '\\"')
            .replace(/\n/g, '\\n')
            .replace(/\r/g, '\\r')
            .replace(/\t/g, '\\t');
    }

    private needsQuoting(s: string): boolean {
        // Check if string needs quoting (contains special chars or isn't a valid identifier)
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s)) {
            return true;
        }
        // Reserved words
        const reserved = ['def', 'over', 'class', 'true', 'false', 'None', 
                         'prepend', 'append', 'add', 'delete', 'reorder',
                         'uniform', 'varying', 'custom', 'variantSet'];
        return reserved.includes(s);
    }
}

