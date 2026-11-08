'use client';

import { useEffect, useRef } from 'react';
import type { Group, Material, Mesh, Object3D } from 'three';

type CoinActor = {
  group: Group;
  x: number;
  y: number;
  speed: number;
  phase: number;
  spin: number;
};

const COIN_POSITIONS = [
  { x: -0.43, phase: 0.1, size: 0.76, speed: 0.15, spin: 0.13 },
  { x: 0.39, phase: 0.36, size: 0.92, speed: 0.12, spin: -0.11 },
  { x: -0.3, phase: 0.66, size: 0.64, speed: 0.17, spin: 0.1 },
  { x: 0.47, phase: 0.86, size: 0.7, speed: 0.14, spin: -0.14 },
];

function tintCoin(object: Object3D) {
  object.traverse((child) => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.forEach((material) => {
      const metal = material as Material & {
        color?: { set: (color: string) => void };
        emissive?: { set: (color: string) => void };
        emissiveIntensity?: number;
        metalness?: number;
        roughness?: number;
        map?: unknown;
      };
      metal.color?.set('#58e9a4');
      metal.emissive?.set('#063b2a');
      if (metal.emissiveIntensity !== undefined) metal.emissiveIntensity = 0.22;
      if (metal.metalness !== undefined) metal.metalness = 0.86;
      if (metal.roughness !== undefined) metal.roughness = 0.32;
      // Preserve the model's relief maps, but replace its gold albedo with Wire's green metal.
      if ('map' in metal) metal.map = null;
    });
  });
}

export default function MemeCoinConstellations() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let disposed = false;
    let frame = 0;
    let renderer: import('three').WebGLRenderer | undefined;
    let actors: CoinActor[] = [];
    let renderFrame: (() => void) | undefined;
    let cleanupResources = () => undefined;

    const load = async () => {
      try {
        const [THREE, { GLTFLoader }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/loaders/GLTFLoader'),
        ]);
        if (disposed) return;

        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
        camera.position.z = 13;
        scene.add(new THREE.HemisphereLight(0xc8ffe4, 0x07130e, 2.1));

        const keyLight = new THREE.DirectionalLight(0x8effc0, 2.6);
        keyLight.position.set(-5, 7, 9);
        scene.add(keyLight);

        const rimLight = new THREE.DirectionalLight(0x7778ff, 1.45);
        rimLight.position.set(6, -3, 4);
        scene.add(rimLight);

        renderer = new THREE.WebGLRenderer({
          canvas,
          alpha: true,
          antialias: false,
          powerPreference: 'low-power',
        });
        renderer.setClearColor(0x000000, 0);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;

        const loader = new GLTFLoader();
        const [coinGltf, shibaGltf] = await Promise.all([
          loader.loadAsync('/models/coin.glb'),
          loader.loadAsync('/models/shiba.glb'),
        ]);
        if (disposed) {
          renderer.dispose();
          return;
        }

        const coin = coinGltf.scene.clone(true);
        coin.rotation.x = Math.PI / 2;
        tintCoin(coin);
        coin.updateMatrixWorld(true);
        const coinBounds = new THREE.Box3().setFromObject(coin);
        const coinSize = coinBounds.getSize(new THREE.Vector3());
        const coinCenter = coinBounds.getCenter(new THREE.Vector3());
        const coinScale = 1.9 / Math.max(coinSize.x, coinSize.y);
        coin.scale.setScalar(coinScale);
        coin.position.set(-coinCenter.x * coinScale, -coinCenter.y * coinScale, -coinCenter.z * coinScale);
        const coinFaceZ = (coinSize.z * coinScale) / 2 + 0.025;

        const shiba = shibaGltf.scene.clone(true);
        shiba.updateMatrixWorld(true);
        const shibaBounds = new THREE.Box3().setFromObject(shiba);
        const shibaSize = shibaBounds.getSize(new THREE.Vector3());
        const shibaCenter = shibaBounds.getCenter(new THREE.Vector3());
        const shibaScale = 1.22 / Math.max(shibaSize.x, shibaSize.y);
        shiba.scale.setScalar(shibaScale);
        shiba.position.set(
          -shibaCenter.x * shibaScale,
          -shibaCenter.y * shibaScale,
          coinFaceZ - shibaBounds.min.z * shibaScale + 0.02,
        );

        const rim = new THREE.Mesh(
          new THREE.TorusGeometry(0.88, 0.018, 5, 52),
          new THREE.MeshStandardMaterial({
            color: '#53f5ad',
            emissive: '#0e6d46',
            emissiveIntensity: 0.7,
            metalness: 0.78,
            roughness: 0.28,
          }),
        );
        rim.position.z = coinFaceZ + 0.02;

        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const anchors = window.innerWidth < 640
          ? [-0.39, 0.4, -0.28, 0.31]
          : COIN_POSITIONS.map((item) => item.x);
        const viewHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
        const actorTemplate = new THREE.Group();
        actorTemplate.add(coin, shiba, rim);

        actors = COIN_POSITIONS.map((item, index) => {
          const group = actorTemplate.clone(true);
          group.scale.setScalar(item.size);
          group.position.set(
            anchors[index] * viewHeight * (window.innerWidth / window.innerHeight) * 0.5,
            viewHeight * (0.5 - item.phase) - 0.55,
            index % 2 === 0 ? -0.7 : 0.4,
          );
          scene.add(group);
          return { group, x: anchors[index], y: group.position.y, speed: item.speed, phase: index * 1.8, spin: item.spin };
        });

        const resize = () => {
          if (!renderer) return;
          const width = window.innerWidth;
          const height = window.innerHeight;
          camera.aspect = width / Math.max(height, 1);
          camera.updateProjectionMatrix();
          renderer.setSize(width, height, false);
          const worldHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
          actors.forEach((actor) => {
            actor.y = Math.min(actor.y, worldHeight / 2 + 1.5);
            actor.group.position.x = actor.x * worldHeight * camera.aspect * 0.5;
          });
          renderFrame?.();
        };

        let previousTime = 0;
        const animate = (time: number) => {
          if (disposed || !renderer) return;
          if (document.hidden) {
            frame = window.requestAnimationFrame(animate);
            return;
          }

          const delta = previousTime ? Math.min((time - previousTime) / 1000, 0.05) : 0;
          previousTime = time;
          const worldHeight = 2 * camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
          const bottom = -worldHeight / 2 - 1.5;
          const top = worldHeight / 2 + 1.5;

          actors.forEach((actor) => {
            if (!reducedMotion) {
              actor.y -= actor.speed * delta;
              if (actor.y < bottom) actor.y = top;
              actor.group.position.y = actor.y;
              const worldWidth = worldHeight * camera.aspect;
              actor.group.position.x = actor.x * worldWidth * 0.5 + Math.sin(time * 0.00016 + actor.phase) * 0.24;
              actor.group.rotation.y += actor.spin * delta;
              actor.group.rotation.z = Math.sin(time * 0.00018 + actor.phase) * 0.035;
            }
          });

          renderer.render(scene, camera);
          if (!reducedMotion) frame = window.requestAnimationFrame(animate);
        };
        renderFrame = () => renderer?.render(scene, camera);
        resize();
        window.addEventListener('resize', resize, { passive: true });
        frame = window.requestAnimationFrame(animate);

        const cleanup = () => {
          window.removeEventListener('resize', resize);
          window.cancelAnimationFrame(frame);
          scene.traverse((object) => {
            const mesh = object as Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry.dispose();
            const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
            materials.forEach((material) => material.dispose());
          });
          renderer?.dispose();
          renderer?.forceContextLoss();
        };
        cleanupResources = cleanup;
      } catch {
        // The decoration is optional; keep the launch flow intact when WebGL is unavailable.
        renderer?.dispose();
        renderer?.forceContextLoss();
      }
    };

    void load();

    return () => {
      disposed = true;
      cleanupResources();
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="wire-meme-constellation" aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
