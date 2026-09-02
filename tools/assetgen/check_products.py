"""check_products.py — 重新导入产物 GLB，断言运行时契约。

每 SKU 断言：
  - 根节点命名 = <sku>；网格命名 <sku>_<role>
  - 三角面预算 ≤ 1500（单实例小件，36+ 实例同屏）
  - 陈列包络：宽 x ≤ 0.42 / 深 y ≤ 0.38 / 高 z ≤ 0.52（货架格 0.45 列距 × 0.55 层距）
  - 底面 z ≥ -0.005（坐板顶）；横向居中 |centerX| ≤ 0.06
  - 材质数 ≤ 6；无贴图（运行时整体转 MeshToonMaterial，贴图会丢）

运行：tools/blender/blender.exe -b --factory-startup -P tools/assetgen/check_products.py
退出码非 0 = 契约破裂。
"""

import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import reset_scene  # noqa: E402

GLB_DIR = 'assets/glb'
SKUS = [
    'cat_cafe', 'undercover', 'gem_trader',
    'civ_rise', 'deep_space', 'dragon_exp',
    'boba_tea', 'hand_brew', 'energy_bar',
    'dice_keychain', 'sticker_pack', 'metal_badge', 'dice_tower',
    'merch_bin',  # 陈列容器（非 SKU）
    'crate',  # 快递纸箱（非 SKU）
    'game_tray', 'drink_tray',  # 陈列托盘（非 SKU）
    'player',  # 店长蒙皮角色（含 idle/walk clip）
]

TRI_BUDGET = 1500
MAX_W, MAX_D, MAX_H = 0.42, 0.38, 0.52
MAX_MATS = 6
# 非货架陈列品的包络放宽（宽×深×高）
ENVELOPE_OVERRIDES = {
    'crate': (0.60, 0.60, 0.62),  # 盖片 rest=闭合（水平盖顶）
    'player': (0.90, 0.90, 1.65),  # 角色（身高 ~1.5）  # 纸箱四片盖外撇，按展开包络
}


def world_bbox(objs):
    from mathutils import Vector
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        for corner in o.bound_box:
            w = o.matrix_world @ Vector(corner)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    return mn, mx


def check_sku(sku):
    errors = []
    path = f'{GLB_DIR}/{sku}.glb'
    if not os.path.exists(path):
        return [f'{sku}: GLB 不存在 {path}']
    reset_scene()
    bpy.ops.import_scene.gltf(filepath=path)
    roots = [o for o in bpy.context.scene.objects if o.parent is None]
    want_root = 'player_rig' if sku == 'player' else sku  # 蒙皮角色根 = 骨架
    if not any(o.name == want_root for o in roots):
        errors.append(f'{sku}: 缺根节点 {want_root}（roots={[o.name for o in roots]}）')
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH'
              and not (o.name == 'Icosphere' and not o.vertex_groups and not o.data.materials)]
    # ↑ 4.5 glTF 导入器对含骨架/动画 GLB 会产出一个默认 Icosphere 幻影（无权重无材质），
    #   three.js 端不存在（已实测），断言时排除
    if not meshes:
        errors.append(f'{sku}: 无网格')
        return errors
    for o in meshes:
        if sku == 'player':
            continue  # 蒙皮角色件按部件命名（骨名_mesh/部件名，非 <sku>_<role> 规则）
        if o.parent and o.parent.name.startswith('Flap'):
            continue  # 铰链盖片节点（运行时契约命名）
        if not o.name.startswith(f'{sku}_'):
            errors.append(f'{sku}: 网格命名违约 {o.name}（应 {sku}_<role>）')
    tris = 0
    for o in meshes:
        o.data.calc_loop_triangles()
        tris += len(o.data.loop_triangles)
    if tris > TRI_BUDGET:
        errors.append(f'{sku}: 三角面超预算 {tris} > {TRI_BUDGET}')
    mn, mx = world_bbox(meshes)
    dim = (mx.x - mn.x, mx.y - mn.y, mx.z - mn.z)
    lim = ENVELOPE_OVERRIDES.get(sku, (MAX_W, MAX_D, MAX_H))
    if dim[0] > lim[0] or dim[1] > lim[1] or dim[2] > lim[2]:
        errors.append(f'{sku}: 包络越界 {dim[0]:.3f}×{dim[1]:.3f}×{dim[2]:.3f}'
                      f'（上限 {lim[0]}×{lim[1]}×{lim[2]}）')
    if mn.z < -0.005:
        errors.append(f'{sku}: 底面悬空/下陷 minZ={mn.z:.4f}')
    if abs((mn.x + mx.x) / 2) > 0.06:
        errors.append(f'{sku}: 横向偏心 centerX={(mn.x + mx.x) / 2:.3f}')
    mats = set()
    for o in meshes:
        for m in o.data.materials:
            if m:
                mats.add(m.name.split('.')[0])
                if m.use_nodes:
                    for n in m.node_tree.nodes:
                        if n.type == 'TEX_IMAGE':
                            errors.append(f'{sku}: 材质含贴图 {m.name}')
    if len(mats) > MAX_MATS:
        errors.append(f'{sku}: 材质数 {len(mats)} > {MAX_MATS}')
    if sku == 'crate':
        names = {o.name for o in bpy.context.scene.objects}
        for need in ('FlapN', 'FlapS', 'FlapE', 'FlapW'):
            if need not in names:
                errors.append(f'crate: 缺铰链节点 {need}')
    if sku == 'player':
        arms = [o for o in bpy.context.scene.objects if o.type == 'ARMATURE']
        if not arms:
            errors.append('player: 缺骨架')
        else:
            bone_names = {b.name for b in arms[0].data.bones}
            for need in ('hips', 'spine', 'head', 'armL', 'armR', 'legL', 'legR'):
                if need not in bone_names:
                    errors.append(f'player: 缺骨骼 {need}')
        clip_names = {a.name.split('.')[0] for a in bpy.data.actions}
        for need in ('idle', 'walk'):
            if need not in clip_names:
                errors.append(f'player: 缺动画 clip {need}')
    print(f'[check] {sku}: {len(meshes)} meshes, {tris} tris, '
          f'dim {dim[0]:.3f}×{dim[1]:.3f}×{dim[2]:.3f}, mats {len(mats)}')
    return errors


def main():
    all_errors = []
    for sku in SKUS:
        all_errors.extend(check_sku(sku))
    if all_errors:
        print('\n[check] FAILED:')
        for e in all_errors:
            print('  ✗', e)
        sys.exit(1)
    print(f'\n[check] PASS：{len(SKUS)} 个 SKU 契约全过')


main()
