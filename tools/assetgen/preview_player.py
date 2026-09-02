"""preview_player.py — 人物模型预览：exec player.py 的原生场景，渲 idle / walk 帧。

运行：tools/blender/blender.exe -b --factory-startup -P tools/assetgen/preview_player.py
"""

import math
import os
import sys

import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import common  # noqa: E402

# exec player.py（其 build() 会建模并导出，场景留在原地）
with open(os.path.join(HERE, 'player.py'), encoding='utf-8') as f:
    exec(compile(f.read(), 'player.py', 'exec'), {'__name__': 'assetgen_build', '__file__': os.path.join(HERE, 'player.py')})

OUT = os.path.join(HERE, 'preview')
os.makedirs(OUT, exist_ok=True)


def set_clip(clip_name, frame):
    """★ finish_actions 后场景是 rest 姿态：按 clip 名从 NLA 轨道找回 action 激活再定帧。"""
    arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
    for track in arm.animation_data.nla_tracks:
        for strip in track.strips:
            if strip.action.name.split('.')[0] == clip_name:
                arm.animation_data.action = strip.action
                bpy.context.scene.frame_set(frame)
                return
    raise RuntimeError(f'clip 未找到: {clip_name}')


def add_stage():
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
    bpy.context.active_object.data.materials.append(mat)


def shoot(path, azimuth_deg, center=(0, 0, 0.8), span=1.6, elev_deg=16):
    dist = max(span * 2.2, 1.2)
    az = math.radians(azimuth_deg)
    el = math.radians(elev_deg)
    c = Vector(center)
    cam_pos = c + Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el))) * dist
    cam = bpy.data.objects.new('Cam', bpy.data.cameras.new('Cam'))
    cam.data.lens = 50
    bpy.context.collection.objects.link(cam)
    cam.location = cam_pos
    direction = c - cam_pos
    cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE_NEXT'
    scene.render.resolution_x = scene.render.resolution_y = 512
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)


add_stage()
set_clip('idle', 1)
shoot(os.path.join(OUT, 'player_idle.png'), azimuth_deg=28)
set_clip('walk', 13)
shoot(os.path.join(OUT, 'player_walk_f13.png'), azimuth_deg=90)  # 真侧视验证剪刀步
print('[preview] player idle/walk done')
