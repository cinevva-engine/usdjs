import test from 'node:test';
import assert from 'node:assert/strict';
import { UsdStage, SdfPath } from '../../dist/index.js';

const SHADER_SAMPLE = `#usda 1.0

(
    defaultPrim = "World"
    endTimeCode = 100
    metersPerUnit = 0.01
    startTimeCode = 0
    subLayers = [
        @./sublayer_sphere.usda@
    ]
    timeCodesPerSecond = 24
    upAxis = "Y"
)

def Xform "World"
{
    def Mesh "Plane"
    {
        float3[] extent = [(-50, 0, -50), (50, 0, 50)]
        int[] faceVertexCounts = [4]
        int[] faceVertexIndices = [0, 2, 3, 1]
        rel material:binding = </World/Looks/PreviewSurface_ground> (
            bindMaterialAs = "weakerThanDescendants"
        )
        normal3f[] normals = [(0, 1, 0), (0, 1, 0), (0, 1, 0), (0, 1, 0)] (
            interpolation = "faceVarying"
        )
        point3f[] points = [(-50, 0, -50), (50, 0, -50), (-50, 0, 50), (50, 0, 50)]
        float2[] primvars:st = [(0, 0), (0, 1), (1, 1), (1, 0)] (
            interpolation = "faceVarying"
        )
        uniform token subdivisionScheme = "none"
        double3 xformOp:rotateXYZ = (0, 0, 0)
        double3 xformOp:scale = (10, 10, 10)
        double3 xformOp:translate = (0, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"]
    }

    def DistantLight "DistantLight" (
        prepend apiSchemas = ["ShapingAPI"]
    )
    {
        float angle = 1
        float intensity = 3000
        float shaping:cone:angle = 180
        float shaping:cone:softness
        float shaping:focus
        color3f shaping:focusTint
        asset shaping:ies:file
        double3 xformOp:rotateXYZ = (315, 0, 0)
        double3 xformOp:scale = (1, 1, 1)
        double3 xformOp:translate = (0, 0, 0)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"]
    }

    def Scope "Looks"
    {
        def Material "PreviewSurface_ground"
        {
            token outputs:surface.connect = </World/Looks/PreviewSurface_ground/Shader.outputs:surface>

            def Shader "Shader"
            {
                uniform token info:id = "UsdPreviewSurface"
                float inputs:clearcoat = 0
                float inputs:clearcoatRoughness = 0.01
                color3f inputs:diffuseColor = (0.15444016, 0.08366759, 0.02802582)
                float inputs:displacement = 0
                color3f inputs:emissiveColor = (0, 0, 0)
                float inputs:ior = 1.5
                float inputs:metallic = 0
                normal3f inputs:normal = (0, 0, 1)
                float inputs:occlusion = 1
                float inputs:opacity = 1
                float inputs:opacityThreshold = 0
                float inputs:roughness = 0.5
                color3f inputs:specularColor = (0, 0, 0)
                int inputs:useSpecularWorkflow = 0
            }
        }
    }
}
`;

test('shader sample: parse and verify structure', () => {
  const stage = UsdStage.openUSDA(SHADER_SAMPLE, '<test>');
  const layer = stage.rootLayer;

  // Check Material prim
  const material = layer.getPrim(SdfPath.parse('/World/Looks/PreviewSurface_ground'));
  assert.ok(material, 'Material should exist');
  assert.strictEqual(material.typeName, 'Material');

  // Check outputs:surface.connect relationship
  // The parser stores it as "outputs:surface.connect" (with field name)
  const surfaceOutputConnect = material.properties?.get('outputs:surface.connect');
  assert.ok(surfaceOutputConnect, 'outputs:surface.connect should exist');
  console.log('outputs:surface.connect property:', JSON.stringify(surfaceOutputConnect, null, 2));
  
  // Also check if base property exists
  const surfaceOutput = material.properties?.get('outputs:surface');
  console.log('outputs:surface (base):', surfaceOutput);
  
  // Check Shader prim
  const shader = layer.getPrim(SdfPath.parse('/World/Looks/PreviewSurface_ground/Shader'));
  assert.ok(shader, 'Shader should exist');
  assert.strictEqual(shader.typeName, 'Shader');

  // Check info:id - it's a property, not metadata
  const infoId = shader.properties?.get('info:id');
  assert.ok(infoId, 'info:id property should exist');
  console.log('Shader info:id property:', infoId);
  // Check if uniform qualifier is stored
  const uniformQualifier = infoId.metadata?.qualifier;
  assert.ok(uniformQualifier, 'uniform qualifier should be stored');
  assert.strictEqual(uniformQualifier?.value, 'uniform');
  assert.deepEqual(infoId.defaultValue, { type: 'token', value: 'UsdPreviewSurface' });

  // Check shader inputs
  const diffuseColor = shader.properties?.get('inputs:diffuseColor');
  assert.ok(diffuseColor, 'inputs:diffuseColor should exist');
  // We normalize float3/color3f as vec3f for parity with USDC and usdcat.
  assert.strictEqual(diffuseColor.defaultValue?.type, 'vec3f');
  const diffuseValue = diffuseColor.defaultValue?.value;
  assert.ok(diffuseValue && diffuseValue.length === 3, 'diffuseColor should be color3f tuple');
  console.log('diffuseColor value:', diffuseValue);

  const roughness = shader.properties?.get('inputs:roughness');
  assert.ok(roughness, 'inputs:roughness should exist');
  assert.strictEqual(roughness.defaultValue, 0.5);

  // Check material binding
  const plane = layer.getPrim(SdfPath.parse('/World/Plane'));
  assert.ok(plane, 'Plane should exist');
  const materialBinding = plane.properties?.get('material:binding');
  assert.ok(materialBinding, 'material:binding should exist');
  assert.strictEqual(materialBinding.defaultValue?.type, 'sdfpath');
  const bindingPath = materialBinding.defaultValue?.value;
  assert.strictEqual(bindingPath, '/World/Looks/PreviewSurface_ground');

  console.log('✓ Shader sample parsed successfully');
  console.log(`  Prims: ${stage.listPrimPaths().length}`);
});

