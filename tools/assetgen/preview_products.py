"""preview_products.py — 原生场景预览渲染（不读 GLB，避免导入器双重变换假象）。

exec products.py 拿到 BUILDERS（__name__ 置非 __main__ 阻止导出），
逐 SKU 渲 2 视角 + 全员货架排布合影，PNG 输出到 tools/assetgen/preview/。
★ 渲完必须逐张用图像查看工具目检。

运行：tools/blender/blender.exe -b --factory-startup -P tools/assetgen/preview_products.py
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import common  # noqa: E402
from common import reset_scene  # noqa: E402

# exec products.py（阻止其 __main__ 导出自执行）
_mod = {'__name__': 'assetgen_build', '__file__': os.path.join(HERE, 'products.py')}
with open(os.path.join(HERE, 'products.py'), encoding='utf-8') as f:
    exec(compile(f.read(), 'products.py', 'exec'), _mod)
BUILDERS = _mod['BUILDERS']
finish_sku = _mod['finish_sku']

OUT = os.path.join(HERE, 'preview')


def add_stage(objs):
    """太阳灯 + 灰世界 + 浅灰地面（仅预览，不导出）。"""
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 3.2
    sun.rotation_euler = (math.radians(50), 0, math.radians(30))
    bpy.context.collection.objects.link(sun)
    world = bpy.data.worlds.new('W')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.35, 0.35, 0.38, 1)
    world.node_tree.nodes['Background'].inputs[1].default_value = 0.6
    bpy.context.scene.world = world
    mat = common.make_mat('m_stage', 'cfc8bc')
    bpy.ops.mesh.primitive_plane_add(size=20, location=(0, 0, -0.001))
    plane = bpy.context.active_object
    plane.data.materials.append(mat)


def bbox_of(objs):
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for o in objs:
        if o.type != 'MESH':
            continue
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    return mn, mx


def shoot(objs, path, azimuth_deg, elev_deg=22, res=512):
    """按包围盒自动取景：正面 = -Y，azimuth 0 = 正前方。"""
    mn, mx = bbox_of(objs)
    center = (mn + mx) / 2
    span = max(mx - mn)  # 最大边
    dist = max(span * 2.4, 0.5)
    az = math.radians(azimuth_deg)
    el = math.radians(elev_deg)
    # az 0 → 相机在 -Y（正前方）；绕 Z 旋转
    cam_pos = center + Vector((
        math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el),
    )) * dist
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    cam.data.lens = 50
    bpy.context.collection.objects.link(cam)
    cam.location = cam_pos
    direction = center - cam_pos
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x = scene.render.resolution_y = res
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


def main():
    os.makedirs(OUT, exist_ok=True)
    only = None
    if '--' in sys.argv:
        args = sys.argv[sys.argv.index('--') + 1:]
        if args and args[0] == '--only':
            only = args[1].split(',')
    # 逐 SKU：正面 3/4（az 30°）+ 正侧（az 90°，检验侧面剪影/背面穿帮）
    for sku, fn in BUILDERS.items():
        if only and sku not in only:
            continue
        reset_scene()
        res = fn()
        meshes = finish_sku(res[0], res[1], None, res[2] if len(res) > 2 else None)
        add_stage(meshes)
        shoot(meshes, os.path.join(OUT, f'{sku}_hero.png'), azimuth_deg=32)
        shoot(meshes, os.path.join(OUT, f'{sku}_side.png'), azimuth_deg=90)
        print(f'[preview] {sku} done')
    if only:
        return

    # 全员合影：货架格排布（5 列），检验同框风格一致性
    reset_scene()
    all_meshes = []
    cols = 5
    for i, (sku, fn) in enumerate(BUILDERS.items()):
        res = fn()
        meshes = finish_sku(res[0], res[1], None, res[2] if len(res) > 2 else None)
        gx = (i % cols - (cols - 1) / 2) * 0.55
        gy = -(i // cols) * 0.65
        for m in meshes:
            m.location.x += gx
            m.location.y += gy
        all_meshes.extend(meshes)
    add_stage(all_meshes)
    shoot(all_meshes, os.path.join(OUT, 'lineup.png'), azimuth_deg=0, elev_deg=18, res=1280)
    print('[preview] lineup done')


main()
