/**
 * MaterialX XML parser - converts MaterialX XML to USD SdfLayer format.
 * 
 * Supports:
 * - UsdPreviewSurface shader nodes
 * - standard_surface shader nodes (mapped to UsdPreviewSurface)
 * - surfacematerial nodes
 * - nodegraph with tiledimage/image texture nodes
 * - Basic input types: color3, float, int, string, filename
 */

import { SdfLayer, type SdfPrimSpec, type SdfPropertySpec, type SdfValue } from '../sdf/layer.js';
import { SdfPath } from '../sdf/path.js';

export interface MaterialXParseOptions {
    identifier?: string;
}

interface MaterialXInput {
    type: string;
    value?: string;
    nodename?: string;
    nodegraph?: string;
    output?: string;
}

interface MaterialXNode {
    type: string;
    name: string;
    inputs: Map<string, MaterialXInput>;
    outputs: Map<string, { type: string; nodename?: string }>;
}

interface MaterialXNodeGraph {
    name: string;
    nodes: Map<string, MaterialXNode>;
    outputs: Map<string, { type: string; nodename: string }>;
}

/**
 * Parse MaterialX XML text and convert to an SdfLayer.
 * 
 * The resulting layer structure:
 * - /MaterialX (Scope) - root scope
 * - /MaterialX/Materials (Scope) - container for materials
 * - /MaterialX/Materials/<materialName> (Material) - each surfacematerial
 * - /MaterialX/Materials/<materialName>/<shaderName> (Shader) - each shader node
 * - /MaterialX/Materials/<materialName>/<textureName> (Shader) - texture reader nodes
 */
export function parseMaterialXToLayer(src: string, opts: MaterialXParseOptions = {}): SdfLayer {
    const layer = new SdfLayer(opts.identifier ?? '<materialx>');
    
    // Parse the XML
    const doc = parseXML(src);
    if (!doc) {
        console.warn('Failed to parse MaterialX XML');
        return layer;
    }
    
    const materialxEl = doc.documentElement;
    if (materialxEl.tagName !== 'materialx') {
        console.warn('Root element is not <materialx>');
        return layer;
    }
    
    // Get fileprefix for texture paths.
    //
    // MaterialX often authors texture filenames relative to the .mtlx file location (e.g. `tex/foo.jpg`).
    // The XML `fileprefix` attribute is optional and many assets omit it (including usd-wg-assets OpenChessSet).
    //
    // When we have a real identifier, we can treat its directory as an implicit fileprefix so that
    // texture paths can be resolved without needing extra context later.
    const xmlFileprefix = materialxEl.getAttribute('fileprefix') || '';
    const inferDirPrefix = (): string => {
        const id = opts.identifier ?? '';
        // Expect posix-style identifiers in this repo (USD uses forward slashes).
        const slash = id.lastIndexOf('/');
        if (slash < 0) return '';
        return id.substring(0, slash + 1); // include trailing slash
    };
    const baseDirPrefix = inferDirPrefix();
    let fileprefix = xmlFileprefix || '';
    if (fileprefix && baseDirPrefix) {
        // If the XML fileprefix is relative, anchor it to the mtlx directory.
        if (!fileprefix.startsWith('/') && !fileprefix.startsWith('./') && !fileprefix.match(/^[a-z]+:\/\//i)) {
            fileprefix = baseDirPrefix + fileprefix;
        }
    } else if (!fileprefix && baseDirPrefix) {
        fileprefix = baseDirPrefix;
    }
    
    // Collect all nodes by name for reference resolution
    const nodesByName = new Map<string, MaterialXNode>();
    const nodegraphsByName = new Map<string, MaterialXNodeGraph>();
    const materials: MaterialXNode[] = [];
    const shaders: MaterialXNode[] = [];
    
    for (const child of Array.from(materialxEl.children)) {
        if (child.tagName === 'nodegraph') {
            const ng = parseNodeGraph(child);
            if (ng) {
                nodegraphsByName.set(ng.name, ng);
            }
            continue;
        }
        
        const node = parseNode(child);
        if (!node) continue;
        
        nodesByName.set(node.name, node);
        
        if (node.type === 'material' || node.type === 'surfacematerial') {
            materials.push(node);
        } else {
            shaders.push(node);
        }
    }
    
    // Create the /MaterialX root scope
    const materialXScope = layer.ensurePrim(SdfPath.parse('/MaterialX'), 'def');
    materialXScope.typeName = 'Scope';
    
    // Create /MaterialX/Materials scope
    const materialsScope = layer.ensurePrim(SdfPath.parse('/MaterialX/Materials'), 'def');
    materialsScope.typeName = 'Scope';
    
    // Process each material
    for (const mat of materials) {
        const matPath = `/MaterialX/Materials/${mat.name}`;
        const matPrim = layer.ensurePrim(SdfPath.parse(matPath), 'def');
        matPrim.typeName = 'Material';
        matPrim.properties = new Map();
        
        // Find the connected shader
        const surfaceInput = mat.inputs.get('surfaceshader');
        if (surfaceInput?.nodename) {
            const shaderNode = nodesByName.get(surfaceInput.nodename);
            if (shaderNode) {
                // Create the shader prim as child of material
                const shaderPath = `${matPath}/${shaderNode.name}`;
                const shaderPrim = createShaderPrim(layer, shaderPath, shaderNode, nodegraphsByName, matPath, fileprefix);
                
                // Determine the correct output connection based on shader type
                // Use outputs:mtlx:surface.connect for native MaterialX shaders (like standard_surface)
                // Use outputs:surface.connect for UsdPreviewSurface
                const shaderId = getUsdShaderId(shaderNode.type);
                const isMaterialXNative = shaderId === 'ND_standard_surface_surfaceshader';
                const outputKey = isMaterialXNative ? 'outputs:mtlx:surface' : 'outputs:surface';
                
                // Connect material's surface output to shader's output
                const surfaceOutputProp: SdfPropertySpec = {
                    path: SdfPath.property(matPath, outputKey, 'connect'),
                    typeName: 'token',
                    defaultValue: { type: 'sdfpath', value: `${shaderPath}.outputs:surface` },
                    metadata: {},
                };
                matPrim.properties.set(`${outputKey}.connect`, surfaceOutputProp);
            }
        }
    }
    
    // Set the defaultPrim to MaterialX so USD composition can find it
    layer.metadata.defaultPrim = 'MaterialX';
    
    return layer;
}

/**
 * Parse a nodegraph element.
 */
function parseNodeGraph(el: Element): MaterialXNodeGraph | null {
    const name = el.getAttribute('name');
    if (!name) return null;
    
    const nodes = new Map<string, MaterialXNode>();
    const outputs = new Map<string, { type: string; nodename: string }>();
    
    for (const child of Array.from(el.children)) {
        if (child.tagName === 'output') {
            const outputName = child.getAttribute('name') || 'out';
            const outputType = child.getAttribute('type') || 'color3';
            const nodename = child.getAttribute('nodename') || '';
            outputs.set(outputName, { type: outputType, nodename });
        } else {
            // Parse image/tiledimage nodes
            const node = parseNode(child);
            if (node) {
                nodes.set(node.name, node);
            }
        }
    }
    
    return { name, nodes, outputs };
}

/**
 * Resolve a texture path from a nodegraph connection.
 * Returns the texture file path if found, or null.
 */
function resolveTextureFromNodeGraph(
    nodegraphName: string,
    outputName: string,
    nodegraphsByName: Map<string, MaterialXNodeGraph>,
    fileprefix: string
): string | null {
    const ng = nodegraphsByName.get(nodegraphName);
    if (!ng) return null;
    
    const output = ng.outputs.get(outputName);
    if (!output) return null;
    
    const sourceNode = ng.nodes.get(output.nodename);
    if (!sourceNode) return null;
    
    // Check if it's an image/tiledimage node
    if (sourceNode.type === 'tiledimage' || sourceNode.type === 'image') {
        const fileInput = sourceNode.inputs.get('file');
        if (fileInput?.value) {
            // Combine fileprefix with the file path
            let texturePath = fileInput.value;
            // If fileprefix is set and the path is relative, prepend it
            if (fileprefix && !texturePath.startsWith('/') && !texturePath.startsWith('./')) {
                texturePath = fileprefix + texturePath;
            }
            return texturePath;
        }
    }
    
    return null;
}

function createShaderPrim(
    layer: SdfLayer,
    shaderPath: string,
    node: MaterialXNode,
    nodegraphsByName: Map<string, MaterialXNodeGraph>,
    matPath: string,
    fileprefix: string
): SdfPrimSpec {
    const shaderPrim = layer.ensurePrim(SdfPath.parse(shaderPath), 'def');
    shaderPrim.typeName = 'Shader';
    shaderPrim.properties = new Map();
    
    // Set info:id based on the node type
    const shaderId = getUsdShaderId(node.type);
    const infoIdProp: SdfPropertySpec = {
        path: SdfPath.property(shaderPath, 'info:id'),
        typeName: 'token',
        defaultValue: shaderId,
        metadata: { variability: { type: 'token', value: 'uniform' } as SdfValue },
    };
    shaderPrim.properties.set('info:id', infoIdProp);
    
    // For native MaterialX standard_surface, keep original input names
    // For conversion to UsdPreviewSurface, map input names
    const isStandardSurface = node.type === 'standard_surface';
    const isNativeMaterialX = shaderId === 'ND_standard_surface_surfaceshader';
    const textureCount = { value: 0 };
    
    // Track created nodegraphs to avoid duplicates
    const createdNodeGraphs = new Set<string>();
    
    // Convert inputs to USD properties
    for (const [inputName, input] of node.inputs) {
        // For native MaterialX, keep original input names
        // For UsdPreviewSurface, map standard_surface input names
        const usdInputName = isNativeMaterialX 
            ? inputName  // Keep original MaterialX input names
            : (isStandardSurface ? mapStandardSurfaceInput(inputName) : inputName);
        
        if (!usdInputName) continue; // Skip unmapped inputs
        
        const usdPropName = `inputs:${usdInputName}`;
        
        // Check if this input is connected to a nodegraph (texture)
        if (input.nodegraph && input.output) {
            // For native MaterialX, create proper NodeGraph structure
            // For UsdPreviewSurface fallback, use direct UsdUVTexture shaders
            if (isNativeMaterialX) {
                const ng = nodegraphsByName.get(input.nodegraph);
                if (ng) {
                    // Create the NodeGraph prim under the material if not already created
                    const nodegraphPath = `${matPath}/${input.nodegraph}`;
                    if (!createdNodeGraphs.has(input.nodegraph)) {
                        createNodeGraphPrim(layer, nodegraphPath, ng, fileprefix);
                        createdNodeGraphs.add(input.nodegraph);
                    }
                    
                    // Connect shader input to NodeGraph output
                    const prop: SdfPropertySpec = {
                        path: SdfPath.property(shaderPath, usdPropName, 'connect'),
                        typeName: getMtlxToUsdType(input.type, usdInputName),
                        defaultValue: { type: 'sdfpath', value: `${nodegraphPath}.outputs:${input.output}` },
                        metadata: {},
                    };
                    shaderPrim.properties.set(`${usdPropName}.connect`, prop);
                    continue;
                }
            } else {
                // UsdPreviewSurface fallback: create direct UsdUVTexture shaders
                const texturePath = resolveTextureFromNodeGraph(
                    input.nodegraph,
                    input.output,
                    nodegraphsByName,
                    fileprefix
                );
                
                if (texturePath) {
                    // Create a texture reader shader and connect it
                    const textureShaderName = `texture_${usdInputName.replace(/[^a-zA-Z0-9]/g, '_')}_${textureCount.value++}`;
                    const textureShaderPath = `${matPath}/${textureShaderName}`;
                    createTextureReaderPrim(layer, textureShaderPath, texturePath, input.type);
                    
                    // Connect shader input to texture output
                    const outputType = input.type === 'float' ? 'r' : 'rgb';
                    const prop: SdfPropertySpec = {
                        path: SdfPath.property(shaderPath, usdPropName, 'connect'),
                        typeName: getMtlxToUsdType(input.type, usdInputName),
                        defaultValue: { type: 'sdfpath', value: `${textureShaderPath}.outputs:${outputType}` },
                        metadata: {},
                    };
                    shaderPrim.properties.set(`${usdPropName}.connect`, prop);
                    continue;
                }
            }
        }
        
        // Regular value input
        const { typeName, value } = convertMaterialXInput(usdInputName, input);
        
        if (value !== undefined) {
            const prop: SdfPropertySpec = {
                path: SdfPath.property(shaderPath, usdPropName),
                typeName,
                defaultValue: value,
                metadata: {},
            };
            shaderPrim.properties.set(usdPropName, prop);
        }
    }
    
    // Add standard outputs for surface shaders (both UsdPreviewSurface and native MaterialX)
    if (shaderId === 'UsdPreviewSurface' || shaderId === 'ND_standard_surface_surfaceshader') {
        const surfaceOutputProp: SdfPropertySpec = {
            path: SdfPath.property(shaderPath, 'outputs:surface'),
            typeName: 'token',
            metadata: {},
        };
        shaderPrim.properties.set('outputs:surface', surfaceOutputProp);
        
        // Only UsdPreviewSurface has displacement output
        if (shaderId === 'UsdPreviewSurface') {
            const displacementOutputProp: SdfPropertySpec = {
                path: SdfPath.property(shaderPath, 'outputs:displacement'),
                typeName: 'token',
                metadata: {},
            };
            shaderPrim.properties.set('outputs:displacement', displacementOutputProp);
        }
    }
    
    return shaderPrim;
}

/**
 * Create a NodeGraph prim with outputs and internal image shaders.
 * This matches the structure of flattened MaterialX files.
 */
function createNodeGraphPrim(
    layer: SdfLayer,
    nodegraphPath: string,
    ng: MaterialXNodeGraph,
    fileprefix: string
): SdfPrimSpec {
    const ngPrim = layer.ensurePrim(SdfPath.parse(nodegraphPath), 'def');
    ngPrim.typeName = 'NodeGraph';
    ngPrim.properties = new Map();
    
    // Track which nodes have been created to avoid duplicates
    const createdNodes = new Set<string>();
    
    // Helper to create an image shader node inside the NodeGraph
    const createImageShaderNode = (node: MaterialXNode, outputType: string): string => {
        const imageShaderPath = `${nodegraphPath}/${node.name}`;
        
        if (createdNodes.has(node.name)) {
            return imageShaderPath;
        }
        createdNodes.add(node.name);
        
        const imageShaderPrim = layer.ensurePrim(SdfPath.parse(imageShaderPath), 'def');
        imageShaderPrim.typeName = 'Shader';
        imageShaderPrim.properties = new Map();
        
        // Set info:id based on the output type
        const shaderId = outputType === 'float' ? 'ND_tiledimage_float' : 'ND_tiledimage_color3';
        const infoIdProp: SdfPropertySpec = {
            path: SdfPath.property(imageShaderPath, 'info:id'),
            typeName: 'token',
            defaultValue: shaderId,
            metadata: { variability: { type: 'token', value: 'uniform' } as SdfValue },
        };
        imageShaderPrim.properties.set('info:id', infoIdProp);
        
        // Set the file input
        const fileInput = node.inputs.get('file');
        if (fileInput?.value) {
            let texturePath = fileInput.value;
            // If fileprefix is set and the path is relative, prepend it
            if (fileprefix && !texturePath.startsWith('/') && !texturePath.startsWith('./')) {
                texturePath = fileprefix + texturePath;
            }
            const fileProp: SdfPropertySpec = {
                path: SdfPath.property(imageShaderPath, 'inputs:file'),
                typeName: 'asset',
                defaultValue: { type: 'asset', value: texturePath },
                metadata: {},
            };
            imageShaderPrim.properties.set('inputs:file', fileProp);
        }
        
        // Add output for the image shader
        const imageOutputProp: SdfPropertySpec = {
            path: SdfPath.property(imageShaderPath, 'outputs:out'),
            typeName: outputType === 'float' ? 'float' : 'color3f',
            metadata: {},
        };
        imageShaderPrim.properties.set('outputs:out', imageOutputProp);
        
        return imageShaderPath;
    };
    
    // Helper to create a normalmap shader node inside the NodeGraph
    const createNormalmapShaderNode = (node: MaterialXNode, imageShaderPath: string): string => {
        const normalmapPath = `${nodegraphPath}/${node.name}`;
        
        if (createdNodes.has(node.name)) {
            return normalmapPath;
        }
        createdNodes.add(node.name);
        
        const normalmapPrim = layer.ensurePrim(SdfPath.parse(normalmapPath), 'def');
        normalmapPrim.typeName = 'Shader';
        normalmapPrim.properties = new Map();
        
        // Set info:id for normalmap node
        const infoIdProp: SdfPropertySpec = {
            path: SdfPath.property(normalmapPath, 'info:id'),
            typeName: 'token',
            defaultValue: 'ND_normalmap',
            metadata: { variability: { type: 'token', value: 'uniform' } as SdfValue },
        };
        normalmapPrim.properties.set('info:id', infoIdProp);
        
        // Connect input to the image shader output
        const inConnectProp: SdfPropertySpec = {
            path: SdfPath.property(normalmapPath, 'inputs:in', 'connect'),
            typeName: 'vector3f',
            defaultValue: { type: 'sdfpath', value: `${imageShaderPath}.outputs:out` },
            metadata: {},
        };
        normalmapPrim.properties.set('inputs:in.connect', inConnectProp);
        
        // Add output for the normalmap shader
        const outputProp: SdfPropertySpec = {
            path: SdfPath.property(normalmapPath, 'outputs:out'),
            typeName: 'vector3f',
            metadata: {},
        };
        normalmapPrim.properties.set('outputs:out', outputProp);
        
        return normalmapPath;
    };
    
    // Create output properties that connect to internal image shaders
    for (const [outputName, output] of ng.outputs) {
        const sourceNode = ng.nodes.get(output.nodename);
        if (!sourceNode) continue;
        
        // Direct image/tiledimage node
        if (sourceNode.type === 'tiledimage' || sourceNode.type === 'image') {
            const imageShaderPath = createImageShaderNode(sourceNode, output.type);
            
            // Create NodeGraph output that connects to the image shader
            const ngOutputProp: SdfPropertySpec = {
                path: SdfPath.property(nodegraphPath, `outputs:${outputName}`, 'connect'),
                typeName: output.type === 'float' ? 'float' : 'color3f',
                defaultValue: { type: 'sdfpath', value: `${imageShaderPath}.outputs:out` },
                metadata: {},
            };
            ngPrim.properties.set(`outputs:${outputName}.connect`, ngOutputProp);
        }
        // Normalmap node - trace through to the underlying image
        else if (sourceNode.type === 'normalmap') {
            // Find the image node that feeds into the normalmap
            const inInput = sourceNode.inputs.get('in');
            if (inInput?.nodename) {
                const imageNode = ng.nodes.get(inInput.nodename);
                if (imageNode && (imageNode.type === 'tiledimage' || imageNode.type === 'image')) {
                    // Create the image shader
                    const imageShaderPath = createImageShaderNode(imageNode, 'vector3');
                    
                    // Create the normalmap shader
                    const normalmapPath = createNormalmapShaderNode(sourceNode, imageShaderPath);
                    
                    // Create NodeGraph output that connects to the normalmap shader
                    const ngOutputProp: SdfPropertySpec = {
                        path: SdfPath.property(nodegraphPath, `outputs:${outputName}`, 'connect'),
                        typeName: 'vector3f',
                        defaultValue: { type: 'sdfpath', value: `${normalmapPath}.outputs:out` },
                        metadata: {},
                    };
                    ngPrim.properties.set(`outputs:${outputName}.connect`, ngOutputProp);
                }
            }
        }
    }
    
    return ngPrim;
}

/**
 * Create a UsdUVTexture shader prim for reading textures.
 */
function createTextureReaderPrim(
    layer: SdfLayer,
    shaderPath: string,
    texturePath: string,
    outputType: string
): SdfPrimSpec {
    const shaderPrim = layer.ensurePrim(SdfPath.parse(shaderPath), 'def');
    shaderPrim.typeName = 'Shader';
    shaderPrim.properties = new Map();
    
    // Set info:id to UsdUVTexture
    const infoIdProp: SdfPropertySpec = {
        path: SdfPath.property(shaderPath, 'info:id'),
        typeName: 'token',
        defaultValue: 'UsdUVTexture',
        metadata: { variability: { type: 'token', value: 'uniform' } as SdfValue },
    };
    shaderPrim.properties.set('info:id', infoIdProp);
    
    // Set the file input
    const fileProp: SdfPropertySpec = {
        path: SdfPath.property(shaderPath, 'inputs:file'),
        typeName: 'asset',
        defaultValue: { type: 'asset', value: texturePath },
        metadata: {},
    };
    shaderPrim.properties.set('inputs:file', fileProp);
    
    // Add outputs based on type
    if (outputType === 'float') {
        const rOutputProp: SdfPropertySpec = {
            path: SdfPath.property(shaderPath, 'outputs:r'),
            typeName: 'float',
            metadata: {},
        };
        shaderPrim.properties.set('outputs:r', rOutputProp);
    } else {
        const rgbOutputProp: SdfPropertySpec = {
            path: SdfPath.property(shaderPath, 'outputs:rgb'),
            typeName: 'float3',
            metadata: {},
        };
        shaderPrim.properties.set('outputs:rgb', rgbOutputProp);
    }
    
    return shaderPrim;
}

/**
 * Map standard_surface input names to UsdPreviewSurface input names.
 * Returns null for inputs that don't map.
 */
function mapStandardSurfaceInput(name: string): string | null {
    const mapping: Record<string, string | null> = {
        // Base layer
        'base': null, // No direct mapping, modifies base_color
        'base_color': 'diffuseColor',
        
        // Specular
        'specular': null, // Incorporated into roughness/metallic
        'specular_color': 'specularColor',
        'specular_roughness': 'roughness',
        'specular_IOR': 'ior',
        
        // Metalness
        'metalness': 'metallic',
        
        // Emission
        'emission': null,
        'emission_color': 'emissiveColor',
        
        // Coat (clearcoat)
        'coat': 'clearcoat',
        'coat_color': 'diffuseColor', // Use coat_color as diffuseColor when available
        'coat_roughness': 'clearcoatRoughness',
        
        // Transmission
        'transmission': 'opacity', // Inverse relationship
        
        // Opacity
        'opacity': 'opacity',
        
        // Normal
        'normal': 'normal',
    };
    
    return mapping[name] !== undefined ? mapping[name] : name;
}

function getUsdShaderId(mtlxType: string): string {
    // Map MaterialX node types to USD shader IDs
    // Use native MaterialX shader IDs where available to preserve accuracy
    const typeMap: Record<string, string> = {
        'UsdPreviewSurface': 'UsdPreviewSurface',
        'surfaceshader': 'UsdPreviewSurface', // Assume UsdPreviewSurface for surfaceshader
        'standard_surface': 'ND_standard_surface_surfaceshader', // Native MaterialX standard surface
    };
    return typeMap[mtlxType] || 'UsdPreviewSurface';
}

function convertMaterialXInput(
    name: string,
    input: MaterialXInput
): { typeName: string; value?: SdfValue } {
    const { type, value } = input;
    
    if (value === undefined) {
        // No value, possibly a connection - skip for now
        return { typeName: getMtlxToUsdType(type, name) };
    }
    
    switch (type) {
        case 'color3': {
            const parts = value.split(',').map((s) => parseFloat(s.trim()));
            if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
                // Use tuple format - this matches how the viewer's extractShaderInputs expects colors
                return {
                    typeName: 'color3f',
                    value: { type: 'tuple', value: parts },
                };
            }
            break;
        }
        case 'color4': {
            const parts = value.split(',').map((s) => parseFloat(s.trim()));
            if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
                return {
                    typeName: 'color4f',
                    value: { type: 'vec4f', value: parts },
                };
            }
            break;
        }
        case 'float': {
            const num = parseFloat(value);
            if (!isNaN(num)) {
                return { typeName: 'float', value: num };
            }
            break;
        }
        case 'integer':
        case 'int': {
            const num = parseInt(value, 10);
            if (!isNaN(num)) {
                return { typeName: 'int', value: num };
            }
            break;
        }
        case 'boolean': {
            return { typeName: 'bool', value: value === 'true' };
        }
        case 'string': {
            return { typeName: 'string', value };
        }
        case 'filename': {
            return { typeName: 'asset', value: { type: 'asset', value } };
        }
        case 'vector2': {
            const parts = value.split(',').map((s) => parseFloat(s.trim()));
            if (parts.length === 2 && parts.every((n) => !isNaN(n))) {
                return { typeName: 'float2', value: { type: 'vec2f', value: parts } };
            }
            break;
        }
        case 'vector3': {
            const parts = value.split(',').map((s) => parseFloat(s.trim()));
            if (parts.length === 3 && parts.every((n) => !isNaN(n))) {
                return { typeName: 'float3', value: { type: 'vec3f', value: parts } };
            }
            break;
        }
        case 'vector4': {
            const parts = value.split(',').map((s) => parseFloat(s.trim()));
            if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
                return { typeName: 'float4', value: { type: 'vec4f', value: parts } };
            }
            break;
        }
    }
    
    // Default: return as string
    return { typeName: 'string', value };
}

function getMtlxToUsdType(mtlxType: string, propName: string): string {
    // Map MaterialX types to USD types
    const typeMap: Record<string, string> = {
        'color3': 'color3f',
        'color4': 'color4f',
        'float': 'float',
        'integer': 'int',
        'int': 'int',
        'boolean': 'bool',
        'string': 'string',
        'filename': 'asset',
        'vector2': 'float2',
        'vector3': 'float3',
        'vector4': 'float4',
        'surfaceshader': 'token',
        'material': 'token',
    };
    return typeMap[mtlxType] || 'token';
}

function parseNode(el: Element): MaterialXNode | null {
    const name = el.getAttribute('name');
    if (!name) return null;
    
    // Use tagName as the primary node type (e.g., 'tiledimage', 'standard_surface')
    // The 'type' attribute represents the output type (e.g., 'color3', 'float'), not the node type
    const nodeType = el.tagName;
    
    const inputs = new Map<string, MaterialXInput>();
    const outputs = new Map<string, { type: string; nodename?: string }>();
    
    // Parse input children
    for (const child of Array.from(el.children)) {
        if (child.tagName === 'input') {
            const inputName = child.getAttribute('name');
            const inputType = child.getAttribute('type') || 'string';
            const inputValue = child.getAttribute('value') ?? undefined;
            const nodename = child.getAttribute('nodename') ?? undefined;
            const nodegraph = child.getAttribute('nodegraph') ?? undefined;
            const output = child.getAttribute('output') ?? undefined;
            
            if (inputName) {
                inputs.set(inputName, { type: inputType, value: inputValue, nodename, nodegraph, output });
            }
        } else if (child.tagName === 'output') {
            const outputName = child.getAttribute('name') || 'out';
            const outputType = child.getAttribute('type') || 'surfaceshader';
            const nodename = child.getAttribute('nodename') ?? undefined;
            outputs.set(outputName, { type: outputType, nodename });
        }
    }
    
    return { type: nodeType, name, inputs, outputs };
}

/**
 * Simple XML parser using DOMParser if available, or a minimal fallback.
 */
function parseXML(src: string): Document | null {
    // In browser/Node 18+ environments
    if (typeof DOMParser !== 'undefined') {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(src, 'application/xml');
            // Check for parse errors
            const parseError = doc.querySelector('parsererror');
            if (parseError) {
                console.warn('XML parse error:', parseError.textContent);
                return null;
            }
            return doc;
        } catch (e) {
            console.warn('DOMParser failed:', e);
            return null;
        }
    }
    
    // Fallback for environments without DOMParser - use regex-based parsing
    return parseXMLFallback(src);
}

/**
 * Minimal regex-based XML parser fallback for environments without DOMParser.
 */
function parseXMLFallback(src: string): Document | null {
    // This is a very simplified XML parser - just enough for MaterialX files
    // In a real implementation, you'd use a proper XML library
    
    // Create a mock Document interface
    const elements: Map<string, MockElement> = new Map();
    
    // Extract root element
    const rootMatch = src.match(/<materialx[^>]*>([\s\S]*)<\/materialx>/i);
    if (!rootMatch) return null;
    
    const rootContent = rootMatch[1];
    const rootEl = new MockElement('materialx');
    
    // Parse top-level elements within materialx
    const elementRegex = /<(\w+)\s+([^>]*)(?:\/>|>([\s\S]*?)<\/\1>)/g;
    let match;
    
    while ((match = elementRegex.exec(rootContent)) !== null) {
        const [, tagName, attrsStr, content] = match;
        const el = new MockElement(tagName);
        
        // Parse attributes
        const attrRegex = /(\w+)="([^"]*)"/g;
        let attrMatch;
        while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
            el.attributes.set(attrMatch[1], attrMatch[2]);
        }
        
        // Parse children (input elements)
        if (content) {
            const childRegex = /<(\w+)\s+([^>]*)\/?>/g;
            let childMatch;
            while ((childMatch = childRegex.exec(content)) !== null) {
                const childEl = new MockElement(childMatch[1]);
                const childAttrRegex = /(\w+)="([^"]*)"/g;
                let childAttrMatch;
                while ((childAttrMatch = childAttrRegex.exec(childMatch[2])) !== null) {
                    childEl.attributes.set(childAttrMatch[1], childAttrMatch[2]);
                }
                el.childElements.push(childEl);
            }
        }
        
        rootEl.childElements.push(el);
    }
    
    return {
        documentElement: rootEl,
    } as unknown as Document;
}

class MockElement {
    attributes = new Map<string, string>();
    childElements: MockElement[] = [];
    
    constructor(public tagName: string) {}
    
    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }
    
    get children(): MockElement[] {
        return this.childElements;
    }
    
    querySelector(_selector: string): MockElement | null {
        return null;
    }
}

/**
 * Check if text appears to be MaterialX XML format.
 */
export function isMaterialXContent(text: string): boolean {
    const trimmed = text.trim();
    // Check for XML declaration or materialx root element
    return (
        trimmed.startsWith('<?xml') ||
        trimmed.startsWith('<materialx') ||
        /<materialx\s/i.test(trimmed)
    );
}

