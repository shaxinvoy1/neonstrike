// Protsedural atrof-muhit xaritasi (PMREM): to'q ko'k xona + ko'k/cyan/binafsha
// neon panellar → marvarid tana va metall qurollarda ishonchli aks.
import * as THREE from '/vendor/three.module.js';

export function createNeonEnvironment (renderer) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1230);
  const room = new THREE.Mesh(new THREE.BoxGeometry(20, 10, 20), new THREE.MeshBasicMaterial({ color: 0x141d44, side: THREE.BackSide }));
  room.position.y = 4;
  scene.add(room);
  const panel = (color, w, h, x, y, z, ry = 0, rx = 0, k = 1) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z); m.rotation.set(rx, ry, 0);
    scene.add(m);
  };
  panel(0xffffff, 8, 2.2, 0, 8.9, 0, 0, Math.PI / 2, 3.2);      // ship oq yorug'lik
  panel(0x3aa0ff, 9, 1.2, 0, 3, -9.9, 0, 0, 3);                  // ko'k neon
  panel(0x40e8ff, 1, 6, 9.9, 3, 2, -Math.PI / 2, 0, 2.5);        // cyan
  panel(0x8a5cff, 1, 6, -9.9, 3, -3, Math.PI / 2, 0, 2.2);       // binafsha
  panel(0xff9ec8, 3, 1.5, -4, 2, 9.9, Math.PI, 0, 1.2);          // iliq pushti (iridessensiya uchun)
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(scene, 0.035);
  pmrem.dispose();
  scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
  return rt;
}
