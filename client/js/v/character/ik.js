// Ikki suyakli analitik IK (oyoq va qo'llar uchun). Dunyo fazosida ishlaydi:
// upper → mid → end zanjiri, maqsad nuqta va "pole" (tirsak/tizza yo'nalishi).
import * as THREE from '/vendor/three.module.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _n = new THREE.Vector3(), _m = new THREE.Vector3(), _e = new THREE.Vector3();
const _cur = new THREE.Vector3(), _want = new THREE.Vector3();
const _q = new THREE.Quaternion(), _pq = new THREE.Quaternion(), _wq = new THREE.Quaternion();

/** Suyakni shunday buradiki, uning bolasi (child) dunyo nuqtasi `to` ga qarasin */
export function aimBone (bone, childWorld, to) {
  bone.getWorldPosition(_a);
  _cur.subVectors(childWorld, _a).normalize();
  _want.subVectors(to, _a).normalize();
  if (_cur.lengthSq() < 1e-10 || _want.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(_cur, _want);
  bone.getWorldQuaternion(_wq);
  _wq.premultiply(_q);
  bone.parent.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(_wq));
  bone.updateMatrixWorld(true);
}

/**
 * @param upper, mid, end — THREE.Bone (end — oxirgi bo'g'in, masalan hand/ankle)
 * @param target — dunyo nuqtasi (end bo'g'ini shu yerga)
 * @param pole — dunyo nuqtasi (mid shu tomonga egiladi)
 * @returns {number} erishilmagan masofa (0 — aniq yetdi)
 */
export function solveTwoBone (upper, mid, end, target, pole) {
  upper.getWorldPosition(_a);
  mid.getWorldPosition(_b);
  end.getWorldPosition(_c);
  const la = _a.distanceTo(_b), lb = _b.distanceTo(_c);
  const dist = _a.distanceTo(target);
  const d = Math.min(Math.max(dist, Math.abs(la - lb) + 1e-4), la + lb - 1e-4);
  _n.subVectors(target, _a).normalize();
  _m.subVectors(pole, _a);
  _m.addScaledVector(_n, -_m.dot(_n));
  if (_m.lengthSq() < 1e-10) _m.set(0, 0, 1).addScaledVector(_n, -_n.z);
  _m.normalize();
  const cosA = (la * la + d * d - lb * lb) / (2 * la * d);
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _e.copy(_a).addScaledVector(_n, la * cosA).addScaledVector(_m, la * sinA);
  aimBone(upper, _b, _e);
  mid.getWorldPosition(_b);
  end.getWorldPosition(_c);
  _want.copy(_a).addScaledVector(_n, d);           // yetib boriladigan nuqta
  aimBone(mid, _c, _want);
  return Math.max(0, dist - d);
}

/** Suyakning dunyo orientatsiyasini berilgan kvaternionga o'rnatish */
export function setWorldQuaternion (bone, q) {
  bone.parent.getWorldQuaternion(_pq);
  bone.quaternion.copy(_pq.invert().multiply(q));
  bone.updateMatrixWorld(true);
}
