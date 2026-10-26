/* gltfGeometry.js - reads the geometry of one mesh from a glTF 2.0 file.
 * The satellites only use the shape of shootingstar3.gltf (they are drawn with a flat-colored
 * MeshBasicMaterial), so this replaces three's GLTFLoader, which with its BufferGeometryUtils
 * dependency was about a third of the viewer's JavaScript. It handles what a geometry-only
 * export needs: .gltf files with embedded (data: URI) or separate .bin buffers, indexed or
 * not, interleaved or not. Node transforms, materials, morph targets, skins and compressed
 * (Draco/meshopt) geometry are not supported; use GLTFLoader for files that need them.
 */
import * as THREE from 'three';

const COMPONENT_ARRAYS = {
    5120: Int8Array,
    5121: Uint8Array,
    5122: Int16Array,
    5123: Uint16Array,
    5125: Uint32Array,
    5126: Float32Array
};

const COMPONENT_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

const ATTRIBUTE_NAMES = {
    POSITION: 'position',
    NORMAL: 'normal',
    TANGENT: 'tangent',
    TEXCOORD_0: 'uv',
    TEXCOORD_1: 'uv1',
    COLOR_0: 'color'
};

async function loadBuffer(buffer, baseUrl) {
    if (buffer.uri === undefined) {
        throw new Error('glTF buffers without a uri (.glb files) are not supported');
    }
    // fetch() understands data: URIs as well as relative paths
    const response = await fetch(new URL(buffer.uri, baseUrl));
    if (!response.ok) {
        throw new Error(`Failed to load glTF buffer ${buffer.uri}: ${response.status}`);
    }
    return response.arrayBuffer();
}

// The data of one accessor, copied out to a tightly packed typed array
function readAccessor(gltf, buffers, index) {
    const accessor = gltf.accessors[index];
    const ArrayType = COMPONENT_ARRAYS[accessor.componentType];
    const itemSize = COMPONENT_COUNTS[accessor.type];
    if (ArrayType === undefined || itemSize === undefined || accessor.sparse !== undefined) {
        throw new Error(`Unsupported glTF accessor ${index}`);
    }
    const array = new ArrayType(accessor.count * itemSize);
    if (accessor.bufferView === undefined) {
        return { array, itemSize, normalized: accessor.normalized === true }; // all zeros
    }

    const view = gltf.bufferViews[accessor.bufferView];
    const data = buffers[view.buffer];
    const elementBytes = ArrayType.BYTES_PER_ELEMENT * itemSize;
    const stride = view.byteStride ?? elementBytes;
    const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let i = 0; i < accessor.count; i++) {
        const element = new ArrayType(data, start + i * stride, itemSize);
        array.set(element, i * itemSize);
    }
    return { array, itemSize, normalized: accessor.normalized === true };
}

// Geometry of the first primitive of the mesh on the node (or mesh) called meshName, or of the
// first mesh in the file if there is no such name
export async function loadGltfGeometry(url, meshName) {
    const baseUrl = new URL(url, window.location.href);
    const response = await fetch(baseUrl);
    if (!response.ok) {
        throw new Error(`Failed to load ${url}: ${response.status}`);
    }
    const gltf = await response.json();

    const node = gltf.nodes?.find((n) => n.name === meshName && n.mesh !== undefined);
    let meshIndex = node?.mesh ?? gltf.meshes?.findIndex((m) => m.name === meshName);
    if (meshIndex === undefined || meshIndex < 0) {
        meshIndex = 0;
    }
    const primitive = gltf.meshes?.[meshIndex]?.primitives?.[0];
    if (primitive === undefined) {
        throw new Error(`No mesh found in ${url}`);
    }
    if (primitive.extensions !== undefined) {
        throw new Error(`${url} uses glTF extensions that loadGltfGeometry does not support`);
    }

    // Only the buffers this primitive reads from
    const accessorIndices = [...Object.values(primitive.attributes), primitive.indices]
        .filter((i) => i !== undefined);
    const bufferIndices = new Set(accessorIndices
        .map((i) => gltf.accessors[i].bufferView)
        .filter((v) => v !== undefined)
        .map((v) => gltf.bufferViews[v].buffer));
    const buffers = [];
    await Promise.all([...bufferIndices].map(async (b) => {
        buffers[b] = await loadBuffer(gltf.buffers[b], baseUrl);
    }));

    const geometry = new THREE.BufferGeometry();
    for (const [semantic, accessorIndex] of Object.entries(primitive.attributes)) {
        const name = ATTRIBUTE_NAMES[semantic] ?? semantic.toLowerCase();
        const { array, itemSize, normalized } = readAccessor(gltf, buffers, accessorIndex);
        geometry.setAttribute(name, new THREE.BufferAttribute(array, itemSize, normalized));
    }
    if (primitive.indices !== undefined) {
        const { array } = readAccessor(gltf, buffers, primitive.indices);
        geometry.setIndex(new THREE.BufferAttribute(array, 1));
    }
    geometry.computeBoundingSphere();
    geometry.name = meshName ?? '';
    return geometry;
}
