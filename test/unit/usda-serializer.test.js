/**
 * USDA Serializer tests - verify round-trip parsing preserves data
 *
 * Note: this suite uses Node's built-in `node:test` runner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUsdaToLayer, serializeLayerToUsda } from '../../dist/index.js';

test('USDA Serializer: round-trips a simple prim', () => {
  const input = `#usda 1.0
(
    defaultPrim = "World"
)

def Xform "World" {
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('#usda 1.0'));
  assert.ok(output.includes('defaultPrim = "World"'));
  assert.ok(output.includes('def Xform "World"'));
});

test('USDA Serializer: round-trips a sphere with radius', () => {
  const input = `#usda 1.0

def Sphere "Ball" {
    double radius = 10
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  const reparsed = parseUsdaToLayer(output, { identifier: '<test2>' });

  const ballPrim = reparsed.getPrim({ kind: 'prim', primPath: '/Ball' });
  assert.ok(ballPrim);
  assert.equal(ballPrim.typeName, 'Sphere');

  const radiusProp = ballPrim.properties?.get('radius');
  assert.ok(radiusProp);
  assert.equal(radiusProp.defaultValue, 10);
});

test('USDA Serializer: round-trips mesh geometry data (basic)', () => {
  const input = `#usda 1.0

def Mesh "Cube" {
    point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
    int[] faceVertexCounts = [4]
    int[] faceVertexIndices = [0, 1, 2, 3]
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  const reparsed = parseUsdaToLayer(output, { identifier: '<test2>' });

  const cubePrim = reparsed.getPrim({ kind: 'prim', primPath: '/Cube' });
  assert.ok(cubePrim);
  assert.equal(cubePrim.typeName, 'Mesh');

  const points = cubePrim.properties?.get('points');
  assert.ok(points);
  assert.ok(points.defaultValue !== null && points.defaultValue !== undefined);
});

test('USDA Serializer: preserves layer metadata', () => {
  const input = `#usda 1.0
(
    defaultPrim = "World"
    upAxis = "Y"
    metersPerUnit = 0.01
    startTimeCode = 0
    endTimeCode = 100
)

def Xform "World" {
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('defaultPrim = "World"'));
  assert.ok(output.includes('upAxis = "Y"'));
  assert.ok(output.includes('metersPerUnit = 0.01'));
});

test('USDA Serializer: preserves prim metadata', () => {
  const input = `#usda 1.0

def Mesh "MyMesh" (
    kind = "component"
    instanceable = true
)
{
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('kind = "component"'));
  assert.ok(output.includes('instanceable = true'));
});

test('USDA Serializer: round-trips scalar types', () => {
  const input = `#usda 1.0

def "Test" {
    bool boolProp = true
    int intProp = 42
    float floatProp = 3.14
    double doubleProp = 3.14159265359
    string stringProp = "hello world"
    token tokenProp = "myToken"
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  const reparsed = parseUsdaToLayer(output, { identifier: '<test2>' });

  const testPrim = reparsed.getPrim({ kind: 'prim', primPath: '/Test' });
  assert.ok(testPrim);
  assert.equal(testPrim.properties?.get('boolProp')?.defaultValue, true);
  assert.equal(testPrim.properties?.get('intProp')?.defaultValue, 42);
  assert.equal(testPrim.properties?.get('stringProp')?.defaultValue, 'hello world');
});

test('USDA Serializer: preserves vector type declarations', () => {
  const input = `#usda 1.0

def "Test" {
    float3 position = (1, 2, 3)
    double3 translate = (10.5, 20.5, 30.5)
    color3f color = (1, 0, 0)
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('float3 position'));
  assert.ok(output.includes('double3 translate'));
  assert.ok(output.includes('color3f color'));
});

test('USDA Serializer: preserves array type declarations', () => {
  const input = `#usda 1.0

def "Test" {
    int[] indices = [0, 1, 2, 3]
    float[] weights = [0.5, 0.25, 0.25]
    string[] names = ["a", "b", "c"]
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('int[] indices'));
  assert.ok(output.includes('float[] weights'));
  assert.ok(output.includes('string[] names'));
});

test('USDA Serializer: round-trips material bindings (relationship)', () => {
  const input = `#usda 1.0

def Mesh "MyMesh" {
    rel material:binding = </Materials/MyMaterial>
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('material:binding'));
  assert.ok(output.includes('</Materials/MyMaterial>'));
});

test('USDA Serializer: round-trips asset references', () => {
  const input = `#usda 1.0

def "MyPrim" (
    prepend references = @./other.usda@
)
{
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('@./other.usda@'));
});

test('USDA Serializer: round-trips variant sets', () => {
  const input = `#usda 1.0

def "Model" (
    variants = {
        string color = "red"
    }
    variantSets = ["color"]
)
{
    variantSet "color" = {
        "red" {
            color3f primvars:displayColor = (1, 0, 0)
        }
        "blue" {
            color3f primvars:displayColor = (0, 0, 1)
        }
    }
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('variantSet "color"'));
  assert.ok(output.includes('"red"'));
  assert.ok(output.includes('"blue"'));
});

test('USDA Serializer: round-trips timeSamples', () => {
  const input = `#usda 1.0

def Xform "Animated" {
    double3 xformOp:translate.timeSamples = {
        0: (0, 0, 0),
        24: (10, 0, 0),
        48: (10, 10, 0),
    }
    uniform token[] xformOpOrder = ["xformOp:translate"]
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  const reparsed = parseUsdaToLayer(output, { identifier: '<test2>' });

  const prim = reparsed.getPrim({ kind: 'prim', primPath: '/Animated' });
  assert.ok(prim);
  const translateProp = prim.properties?.get('xformOp:translate');
  assert.ok(translateProp);
  assert.ok(translateProp.timeSamples);
  assert.equal(translateProp.timeSamples.size, 3);
});

test('USDA Serializer: round-trips nested hierarchy', () => {
  const input = `#usda 1.0

def Xform "World" {
    def Xform "Group1" {
        def Sphere "Ball" {
            double radius = 5
        }
    }
    def Xform "Group2" {
        def Cube "Box" {
            double size = 2
        }
    }
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  const reparsed = parseUsdaToLayer(output, { identifier: '<test2>' });

  assert.ok(reparsed.getPrim({ kind: 'prim', primPath: '/World' }));
  assert.ok(reparsed.getPrim({ kind: 'prim', primPath: '/World/Group1' }));
  assert.ok(reparsed.getPrim({ kind: 'prim', primPath: '/World/Group1/Ball' }));
  assert.ok(reparsed.getPrim({ kind: 'prim', primPath: '/World/Group2' }));
  assert.ok(reparsed.getPrim({ kind: 'prim', primPath: '/World/Group2/Box' }));
});

test('USDA Serializer: handles None values', () => {
  const input = `#usda 1.0

def "Test" {
    asset texture = None
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);

  assert.ok(output.includes('None'));
});

test('USDA Serializer: handles matrices', () => {
  const input = `#usda 1.0

def Xform "MyXform" {
    matrix4d xformOp:transform = (
        (1, 0, 0, 0),
        (0, 1, 0, 0),
        (0, 0, 1, 0),
        (10, 20, 30, 1)
    )
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  assert.ok(output.includes('matrix4d xformOp:transform'));
});

test('USDA Serializer: handles empty prims', () => {
  const input = `#usda 1.0

def "Empty" {
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  const reparsed = parseUsdaToLayer(output, { identifier: '<test2>' });

  assert.ok(reparsed.getPrim({ kind: 'prim', primPath: '/Empty' }));
});

test('USDA Serializer: preserves escaped strings', () => {
  const input = `#usda 1.0

def "Test" {
    string comment = "Line 1\\nLine 2"
    string path = "C:\\\\Users\\\\test"
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  assert.ok(output.includes('\\n'));
});

test('USDA Serializer: handles over specifier', () => {
  const input = `#usda 1.0

over "ExistingPrim" {
    double radius = 20
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  assert.ok(output.includes('over "ExistingPrim"'));
});

test('USDA Serializer: handles class specifier', () => {
  const input = `#usda 1.0

class "_MyClass" {
    double defaultRadius = 10
}
`;
  const layer = parseUsdaToLayer(input, { identifier: '<test>' });
  const output = serializeLayerToUsda(layer);
  assert.ok(output.includes('class "_MyClass"'));
});



