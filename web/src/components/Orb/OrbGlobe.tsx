/**
 * Three.js wireframe globe — lat/long lattice + spiral, depth-faded (TecTimmy-style).
 */
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useStore, type OrbState } from "../../lib/store";

const PALETTE: Record<OrbState, { speed: number; line: number; node: number }> = {
  idle:      { speed: 0.18, line: 1.0, node: 1.0 },
  listening: { speed: 0.28, line: 1.08, node: 1.1 },
  thinking:  { speed: 0.42, line: 1.15, node: 1.15 },
  speaking:  { speed: 0.32, line: 1.12, node: 1.2 },
};

const WIDTH_SEG = 72;
const HEIGHT_SEG = 52;
const INNER_WIDTH = 48;
const INNER_HEIGHT = 36;

function attachVertexColors(geometry: THREE.BufferGeometry) {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

function updateDepthColors(
  geometry: THREE.BufferGeometry,
  group: THREE.Group,
  camera: THREE.Camera,
  lineBoost: number,
  nodeBoost: number,
  backFloor: number,
  frontGain: number,
) {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const col = geometry.attributes.color as THREE.BufferAttribute;
  if (!col) return;

  group.updateMatrixWorld(true);
  const view = new THREE.Matrix4().copy(camera.matrixWorldInverse).multiply(group.matrixWorld);
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(view);
    const depth = THREE.MathUtils.clamp((-v.z - 0.35) / 2.2, 0, 1);
    const front = backFloor + depth * frontGain;
    const line = front * lineBoost;
    col.setXYZ(i, line * 0.05, line * 0.82, line * 1.0);
    void nodeBoost;
  }
  col.needsUpdate = true;
}

function buildFibonacciSpiral(radius: number, n: number): Float32Array {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const y = 1 - t * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    pts.push(Math.cos(theta) * ring * radius, y * radius, Math.sin(theta) * ring * radius);
  }
  return new Float32Array(pts);
}

export default function OrbGlobe() {
  const groupRef = useRef<THREE.Group>(null);
  const outerLinesRef = useRef<THREE.LineSegments>(null);
  const innerLinesRef = useRef<THREE.LineSegments>(null);
  const spiralRef = useRef<THREE.Line>(null!);
  const nodesRef = useRef<THREE.Points>(null);
  const coreRef = useRef<THREE.Group>(null);

  const smooth = useRef({ speed: PALETTE.idle.speed, line: 1, node: 1, audio: 0 });

  const { outerWire, innerWire, nodeGeo, spiralGeo, spiralLine } = useMemo(() => {
    const outerSphere = new THREE.SphereGeometry(1, WIDTH_SEG, HEIGHT_SEG);
    const innerSphere = new THREE.SphereGeometry(0.9, INNER_WIDTH, INNER_HEIGHT);

    const outerWire = new THREE.WireframeGeometry(outerSphere);
    const innerWire = new THREE.WireframeGeometry(innerSphere);
    attachVertexColors(outerWire);
    attachVertexColors(innerWire);

    const nodeGeo = new THREE.BufferGeometry();
    nodeGeo.setAttribute("position", outerSphere.attributes.position.clone());
    attachVertexColors(nodeGeo);

    const spiralGeo = new THREE.BufferGeometry();
    spiralGeo.setAttribute("position", new THREE.BufferAttribute(buildFibonacciSpiral(1.012, 140), 3));
    attachVertexColors(spiralGeo);

    const spiralMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.75,
      blending: THREE.NormalBlending,
      depthWrite: false,
    });
    const spiralLine = new THREE.Line(spiralGeo, spiralMat);

    outerSphere.dispose();
    innerSphere.dispose();

    return { outerWire, innerWire, nodeGeo, spiralGeo, spiralLine };
  }, []);

  useFrame(({ camera }, delta) => {
    const st = useStore.getState();
    const pal = PALETTE[st.orbState];
    const sm = smooth.current;
    const k = 0.08;
    sm.speed += (pal.speed - sm.speed) * k;
    sm.line += (pal.line - sm.line) * k;
    sm.node += (pal.node - sm.node) * k;
    sm.audio += (st.audioLevel - sm.audio) * k * 2;

    const g = groupRef.current;
    if (!g) return;

    g.rotation.y += delta * sm.speed;
    g.rotation.x += delta * sm.speed * 0.26;

    const pulse = 1 + sm.audio * 0.12;
    if (coreRef.current) {
      coreRef.current.scale.setScalar(pulse);
    }

    const backFloor = 0.12;
    const frontGain = 0.88;

    if (outerLinesRef.current) {
      updateDepthColors(outerWire, g, camera, sm.line * 1.05, sm.node, backFloor, frontGain);
    }
    if (innerLinesRef.current) {
      updateDepthColors(innerWire, g, camera, sm.line * 0.72, sm.node, backFloor * 0.85, frontGain * 0.75);
    }
    if (nodesRef.current) {
      updateDepthColors(nodeGeo, g, camera, sm.node * 0.35, sm.node, backFloor, frontGain);
      const col = nodeGeo.attributes.color as THREE.BufferAttribute;
      for (let i = 0; i < col.count; i++) {
        const r = col.getX(i);
        const gr = col.getY(i);
        const b = col.getZ(i);
        const lum = Math.max(r, gr, b);
        const hot = 0.55 + lum * 0.65;
        col.setXYZ(i, hot * 0.75, hot * 0.95, hot);
      }
      col.needsUpdate = true;
    }
    if (spiralRef.current) {
      updateDepthColors(spiralGeo, g, camera, sm.line * 0.95, sm.node, backFloor, frontGain);
      const smat = spiralRef.current.material as THREE.LineBasicMaterial;
      smat.opacity = 0.55 + sm.line * 0.22;
    }
  });

  return (
    <group ref={groupRef}>
      <group ref={coreRef}>
        <mesh>
          <sphereGeometry args={[0.07, 24, 24]} />
          <meshBasicMaterial color="#ffffff" transparent opacity={0.98} depthWrite={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.2, 24, 24]} />
          <meshBasicMaterial
            color="#7df9ff"
            transparent
            opacity={0.35}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
        <mesh>
          <sphereGeometry args={[0.38, 24, 24]} />
          <meshBasicMaterial
            color="#00d4ff"
            transparent
            opacity={0.12}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
          />
        </mesh>
      </group>

      <lineSegments ref={innerLinesRef} geometry={innerWire} frustumCulled={false}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.55}
          blending={THREE.NormalBlending}
          depthWrite={false}
        />
      </lineSegments>

      <lineSegments ref={outerLinesRef} geometry={outerWire} frustumCulled={false}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.92}
          blending={THREE.NormalBlending}
          depthWrite={false}
        />
      </lineSegments>

      <primitive ref={spiralRef} object={spiralLine} frustumCulled={false} />

      <points ref={nodesRef} geometry={nodeGeo} frustumCulled={false}>
        <pointsMaterial
          vertexColors
          size={0.045}
          sizeAttenuation
          transparent
          opacity={0.95}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}
