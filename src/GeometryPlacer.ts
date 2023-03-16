import * as THREE from 'three';
import vertexSource from '../resources/glsl/vertex.glsl?raw';
import fragmentSource from '../resources/glsl/fragment.glsl?raw';

enum Offset {
    TOP = 16,
    NORTH = 0,
    EAST = 8,
    SOUTH = 32,
    WEST = 40,
    BOTTOM = 24
}

export class UnpackedSchematic {
    private sizeX: number;
    private sizeY: number;
    private sizeZ: number;

    private textureCount: number | undefined;
    private textureData: string | undefined;
    private textureDictionary: {
        [index: string]: {
            [index: string]: number
        }
    } | undefined;

    private schematic: number[] = [];

    private blockCounts: Map<number, number> = new Map();

    constructor(sizeX: number, sizeY: number, sizeZ: number) {
        this.sizeX = sizeX;
        this.sizeY = sizeY;
        this.sizeZ = sizeZ;

        this.schematic = [];
    }

    public setBlock(type: number, x: number, y: number, z: number) {
        if (!this.blockCounts.has(type) && type != 0) 
            this.blockCounts.set(type, 0);

        this.blockCounts.set(type, this.blockCounts.get(type)! + 1);

        if (x < 0 || x >= this.sizeX || y < 0 || y >= this.sizeY || z < 0 || z >= this.sizeZ)
            throw new Error("Block is out of bounds!");

        this.schematic[this.getSchematicLocation(x, y, z)] = type;
    }

    public pushBlock(type: number) {
        if (!this.blockCounts.has(type) && type != 0)
            this.blockCounts.set(type, 0);

        this.blockCounts.set(type, this.blockCounts.get(type)! + 1);

        if (this.schematic.length > this.sizeX * this.sizeY * this.sizeZ) {
            throw new Error("Schematic is full!");
        }

        this.schematic.push(type);
    }

    // todo: might be wrong
    private getSchematicLocation(x: number, y: number, z: number) {
        return x + y * this.sizeX + z * this.sizeX * this.sizeY;
    }

    /**
     * @param {string} texture The texture data in a base64 encoded png where all the textures are lined up from left to right.
     * @param {number} textureCount The total amount of textures in the texture data.
     * @param {number} textureResolution The resolution of the textures in the texture data.
     * @param {{ [index: string]: { [index: string]: number } }} textureMapping The mapping that the block types will have for the textures.
     * 
     * The format of the mapping is as follows:
     * ```json
     * {
     * .    "blockType": {
     * .        "textureMapping": textureIndex,
     * .        "textureMapping2": textureIndex2,
     * .        [...]
     * .    }
     * }
     * ```
     * 
     * Where blockType is an index used to determine the current block type, 
     * textureMapping is the mapping that the block type will have for the textures,
     * and textureIndex is the index of the texture in the texture data (starting from 0).
     * 
     * Available textureMappings are:
     * - top
     * - bottom
     * - north
     * - east
     * - south
     * - front (north)
     * - all (6 sides)
     * - sides (north, east, south, west)
     * - end (top, bottom)
     * @returns {void}
     * @memberof UnpackedSchematic
     */
    public setTextureData(texture: string, textureCount: number, textureMapping: { [index: string]: { [index: string]: number } }) {
        this.textureData = texture;
        this.textureCount = textureCount;
        this.textureDictionary = textureMapping;
    }

    public getBlockCount() {
        return this.blockCounts;
    }

    public getSchem() {
        return this.schematic;
    }

    public getSizeX() {
        return this.sizeX;
    }

    public getSizeY() {
        return this.sizeY;
    }

    public getSizeZ() {
        return this.sizeZ;
    }

    public getTextureData() {
        return this.textureData;
    }

    public getTextureCount() {
        return this.textureCount;
    }

    public getTextureDictionary() {
        return this.textureDictionary;
    }
}

export class GeometryPlacer {
    private schematic: UnpackedSchematic | undefined;
    private uvCache: { [index: string]: Float32Array } = {};

    public create(schematic: UnpackedSchematic, output: (mesh: THREE.InstancedMesh) => void) {
        if (!schematic.getTextureCount() || !schematic.getTextureData() || !schematic.getTextureDictionary())
            throw new Error("Texture data is not set!");

        this.schematic = schematic;
    
        // material preparation (Texture / WebGLMatrialObject)
        const material = this.generateMaterial();

        // geometry preparation (BufferGeometry)
        const typeToUV = new Map<number, THREE.BufferAttribute>();
        const blockTypes = this.schematic.getBlockCount().keys();
        for (let blockType of blockTypes) {
            const uv = this.unwrapUVs(blockType);
            if (uv) {
                typeToUV.set(blockType, new THREE.BufferAttribute(uv, 2, false));
            }
        }

        // placing 'em
        const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
        boxGeometry.computeVertexNormals();
        let instancedMeshes = new Map<number, THREE.InstancedMesh>();
        for (let blockType of this.schematic.getBlockCount().keys()) {
            const uv = typeToUV.get(blockType);
            if (uv) {
                const geometry = new THREE.InstancedBufferGeometry();
                geometry.copy(boxGeometry);

                geometry.setAttribute('uv', uv);
                geometry.attributes.uv.needsUpdate = true;
                
                const mesh = new THREE.InstancedMesh(geometry, material, this.schematic.getBlockCount().get(blockType)!);

                instancedMeshes.set(blockType, mesh);

                output(mesh);
            }
        }

        // shift em to correct position
        let blockIndexes = new Map<number, number>();
        let dummy = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
        let index = 0;

        for (let x = 0; x < this.schematic.getSizeX(); x++) {
            for (let y = 0; y < this.schematic.getSizeY(); y++) {
                for (let z = 0; z < this.schematic.getSizeZ(); z++) {
                    const blockType = this.schematic.getSchem()[index];
                    const mesh = instancedMeshes.get(blockType);
                    if (mesh) {
                        dummy.position.set(x, y, z);
                        dummy.updateMatrix();
                    
                        let currentIndex = blockIndexes.get(blockType) ?? 0;
                        mesh.setMatrixAt(currentIndex, dummy.matrix);
                        
                        blockIndexes.set(blockType, currentIndex + 1);
                    }
                    index++;
                }
            }
        }

        // update all meshes
        for (let mesh of instancedMeshes.values()) {
            mesh.matrixAutoUpdate = false;
            mesh.instanceMatrix.needsUpdate = true;
        }
    }

    private mapTextures(mapping: Float32Array, stride: number, offset: number) {
        let textureAmount = this.schematic!.getTextureCount()!;
        let u0 = (stride + 1) / textureAmount + 0.00001;
        let v0 = 0.0;
        let u1 = (stride + 1 + 1) / textureAmount - 0.00001;
        let v1 = 1.0;
    
        let uvs = [u1, v1, u0, v1, u1, v0, u0, v0];
    
        for (let i = 0; i < 8; i++) {
            if (mapping[offset + i] == -1) // if the value is already set, don't overwrite it (why do some blocks have multiple textures per faceee)
                mapping[offset + i] = uvs[i];
        }
    }
    

    private unwrapUVs(blockType: number) {
        if (!this.uvCache[blockType]) {
            let blockUVData = this.schematic!.getTextureDictionary()![blockType];

            if (Object.keys(blockUVData).length == 0) return undefined;

            let uvMappedFaces = new Float32Array(48);
            uvMappedFaces.fill(-1);

            for (let key in blockUVData) {
                const value = blockUVData[key];
                switch (key) {
                    case "all":
                        this.mapTextures(uvMappedFaces, value, Offset.TOP);
                        this.mapTextures(uvMappedFaces, value, Offset.BOTTOM);
                    case "side":
                        this.mapTextures(uvMappedFaces, value, Offset.NORTH);
                        this.mapTextures(uvMappedFaces, value, Offset.EAST);
                        this.mapTextures(uvMappedFaces, value, Offset.SOUTH);
                        this.mapTextures(uvMappedFaces, value, Offset.WEST);
                        break;
                    case "top":
                        this.mapTextures(uvMappedFaces, value, Offset.TOP);
                        break;
                    case "bottom":
                        this.mapTextures(uvMappedFaces, value, Offset.BOTTOM);
                        break;
                    case "end":
                        this.mapTextures(uvMappedFaces, value, Offset.TOP);
                        this.mapTextures(uvMappedFaces, value, Offset.BOTTOM);
                        break;
                    case "front":
                    case "north":
                        this.mapTextures(uvMappedFaces, value, Offset.NORTH);
                        break;
                    case "east":
                        this.mapTextures(uvMappedFaces, value, Offset.EAST);
                        break;
                    case "south":
                        this.mapTextures(uvMappedFaces, value, Offset.SOUTH);
                        break;
                    case "west":
                        this.mapTextures(uvMappedFaces, value, Offset.WEST);
                        break;
                    default: 
                }
            }

            // fill all empty spots of the array (0..47)
            for (let i = 0; i < 48; i++) {
                if (uvMappedFaces[i] == -1) {
                    // console.log("found undefined at index " + i)
                    uvMappedFaces[i] = 0.5;
                }
            }

            this.uvCache[blockType] = uvMappedFaces;
        }
        
        return this.uvCache[blockType];
    }

    private generateMaterial() {
        const texture = new THREE.TextureLoader().load('data:image/png;base64, ' + this.schematic!.getTextureData());

        texture.magFilter = THREE.NearestFilter;
        texture.minFilter = THREE.NearestFilter;
        texture.premultiplyAlpha = true;
        // texture.encoding = THREE.sRGBEncoding;

        const material = new THREE.ShaderMaterial({
            uniforms: {
                uTexture: { 
                    value: texture
                }
            },
            vertexShader: vertexSource,
            fragmentShader: fragmentSource,
            transparent: true
        });

        return material;
    }
}
