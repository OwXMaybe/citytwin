import * as THREE from 'three';
import type { CustomLayerInterface, CustomRenderMethodInput, Map as MlMap } from 'maplibre-gl';
import { maplibregl } from './maplibre';

/**
 * Three.js detail layer rendered inside MapLibre's WebGL context (shared depth buffer,
 * so meshes are correctly occluded by extruded buildings).
 *
 * Local model space: x = metres east, y = metres up, z = metres south of `origin`.
 */

export interface TreePoint {
  lon: number;
  lat: number;
  /** true = tree position mapped in OSM; false = illustrative fill inside a park polygon */
  mapped: boolean;
  seed: number; // 0..1, drives size/colour variation
}

export interface Column {
  lon: number;
  lat: number;
  heightM: number;
  color: string;
}

export interface Pulse {
  lon: number;
  lat: number;
  color: string;
}

const MAX_TREES = 8000;

export class DetailLayer implements CustomLayerInterface {
  readonly id = 'three-detail';
  readonly type = 'custom' as const;
  readonly renderingMode = '3d' as const;

  private map!: MlMap;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.Camera();
  private origin = maplibregl.MercatorCoordinate.fromLngLat([0, 0], 0);
  private scale = 1;
  private modelMatrix = new THREE.Matrix4();

  private trunks: THREE.InstancedMesh;
  private crowns: THREE.InstancedMesh;
  private columns = new THREE.Group();
  private pulses = new THREE.Group();
  private vegetationVisible = true;
  private columnsVisible = false;
  private pulsesVisible = false;

  constructor() {
    this.trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.18, 0.28, 1, 5).translate(0, 0.5, 0), new THREE.MeshLambertMaterial({ color: '#5b4636' }), MAX_TREES);
    this.crowns = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 0), new THREE.MeshLambertMaterial({ color: '#ffffff' }), MAX_TREES);
    for (const m of [this.trunks, this.crowns]) {
      m.count = 0;
      m.frustumCulled = false; // MapLibre supplies the projection; three's culling would be wrong
      this.scene.add(m);
    }
    this.columns.visible = false;
    this.pulses.visible = false;
    this.scene.add(this.columns, this.pulses);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.4, 1, 0.6);
    this.scene.add(sun);
  }

  onAdd(map: MlMap, gl: WebGLRenderingContext | WebGL2RenderingContext) {
    this.map = map;
    this.renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  }

  onRemove() {
    this.renderer?.dispose();
  }

  setOrigin(lon: number, lat: number) {
    this.origin = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
    this.scale = this.origin.meterInMercatorCoordinateUnits();
    this.modelMatrix = new THREE.Matrix4()
      .makeTranslation(this.origin.x, this.origin.y, this.origin.z)
      .scale(new THREE.Vector3(this.scale, -this.scale, this.scale))
      .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  }

  /** lon/lat → local metres (x east, z south). */
  private local(lon: number, lat: number): [number, number] {
    const m = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], 0);
    return [(m.x - this.origin.x) / this.scale, (m.y - this.origin.y) / this.scale];
  }

  setTrees(trees: TreePoint[]) {
    const mat = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const color = new THREE.Color();
    const n = Math.min(trees.length, MAX_TREES);
    for (let i = 0; i < n; i++) {
      const t = trees[i];
      const [x, z] = this.local(t.lon, t.lat);
      const h = 5 + t.seed * 7; // trunk + crown height 5–12 m
      const r = 1.8 + t.seed * 2.2;
      mat.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(1, h * 0.45, 1));
      this.trunks.setMatrixAt(i, mat);
      mat.compose(new THREE.Vector3(x, h * 0.45 + r * 0.7, z), q, new THREE.Vector3(r, r * 1.15, r));
      this.crowns.setMatrixAt(i, mat);
      // OSM-mapped trees slightly brighter than illustrative park fill.
      color.setHSL(0.3 + t.seed * 0.06, 0.45, t.mapped ? 0.36 : 0.26 + t.seed * 0.06);
      this.crowns.setColorAt(i, color);
    }
    this.trunks.count = this.crowns.count = n;
    this.trunks.instanceMatrix.needsUpdate = this.crowns.instanceMatrix.needsUpdate = true;
    if (this.crowns.instanceColor) this.crowns.instanceColor.needsUpdate = true;
    this.map?.triggerRepaint();
  }

  setColumns(cols: Column[]) {
    disposeGroup(this.columns);
    for (const c of cols) {
      const [x, z] = this.local(c.lon, c.lat);
      const h = Math.max(10, c.heightM);
      const mesh = new THREE.Mesh(
        new THREE.CylinderGeometry(110, 110, h, 24, 1, false).translate(0, h / 2, 0),
        new THREE.MeshLambertMaterial({ color: c.color, transparent: true, opacity: 0.82, emissive: new THREE.Color(c.color).multiplyScalar(0.35) }),
      );
      mesh.position.set(x, 0, z);
      mesh.frustumCulled = false;
      const cap = new THREE.Mesh(new THREE.CircleGeometry(150, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: c.color, transparent: true, opacity: 0.25 }));
      cap.position.set(x, 1, z);
      cap.frustumCulled = false;
      this.columns.add(mesh, cap);
    }
    this.map?.triggerRepaint();
  }

  setPulses(items: Pulse[]) {
    disposeGroup(this.pulses);
    for (const p of items) {
      const [x, z] = this.local(p.lon, p.lat);
      const ring = new THREE.Mesh(new THREE.RingGeometry(30, 42, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
      ring.position.set(x, 2, z);
      ring.frustumCulled = false;
      const pin = new THREE.Mesh(new THREE.ConeGeometry(14, 60, 12).rotateX(Math.PI).translate(0, 60, 0), new THREE.MeshLambertMaterial({ color: p.color, emissive: new THREE.Color(p.color).multiplyScalar(0.4) }));
      pin.position.set(x, 0, z);
      pin.frustumCulled = false;
      this.pulses.add(ring, pin);
    }
    this.map?.triggerRepaint();
  }

  setVisibility(v: { vegetation?: boolean; columns?: boolean; pulses?: boolean }) {
    if (v.vegetation !== undefined) this.vegetationVisible = v.vegetation;
    if (v.columns !== undefined) this.columnsVisible = v.columns;
    if (v.pulses !== undefined) this.pulsesVisible = v.pulses;
    this.trunks.visible = this.crowns.visible = this.vegetationVisible;
    this.columns.visible = this.columnsVisible;
    this.pulses.visible = this.pulsesVisible;
    this.map?.triggerRepaint();
  }

  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, args: CustomRenderMethodInput) {
    const proj = new THREE.Matrix4().fromArray(args.defaultProjectionData.mainMatrix as unknown as number[]);
    this.camera.projectionMatrix = proj.multiply(this.modelMatrix);

    const animate = this.pulsesVisible && this.pulses.children.length > 0;
    if (animate) {
      const t = (performance.now() % 1800) / 1800;
      this.pulses.children.forEach((m, i) => {
        if (i % 2) return; // rings are even children
        const s = 1 + t * 3;
        m.scale.set(s, 1, s);
        ((m as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - t);
      });
    }
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    if (animate) this.map.triggerRepaint();
  }
}

function disposeGroup(g: THREE.Group) {
  for (const c of [...g.children]) {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    (m.material as THREE.Material | undefined)?.dispose();
    g.remove(c);
  }
}
