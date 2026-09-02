"""player.py — 店长人物模型（蒙皮角色，含 idle/walk 两条动画 clip）。

赛璐璐低模 Q 版：头+帽 / 身+围裙 / 双臂 / 双腿，刚性绑骨。
clip 契约（运行时按名播放）：idle（40f 呼吸）/ walk（24f 摆腿摆臂循环）。
坐标：正面朝 Blender -Y（= three.js +Z），脚底 z=0。

运行：tools/blender/blender.exe -b --factory-startup -P tools/assetgen/player.py
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    reset_scene, make_mat, box, cyl, cone, sph, tube_between,
    make_armature, bind_rigid, Anim, finish_actions, export_glb, count_tris,
)

OUT_DIR = 'assets/glb'


def build():
    reset_scene()
    skin = make_mat('m_player_skin', 'ffd9b3')
    shirt = make_mat('m_player_shirt', '58b368')
    apron = make_mat('m_player_apron', 'f3e2c2')
    dark = make_mat('m_player_dark', '5b4a3a')
    hat = make_mat('m_player_hat', '8a5a2b')
    hair = make_mat('m_player_hair', '4a3020')

    bones = {
        'hips': ((0, 0, 0.55), (0, 0, 0.78), None),
        'spine': ((0, 0, 0.78), (0, 0, 1.02), 'hips'),
        'head': ((0, 0, 1.02), (0, 0, 1.36), 'spine'),
        'armL': ((0.22, 0, 1.0), (0.34, 0, 0.72), 'spine'),
        'armR': ((-0.22, 0, 1.0), (-0.34, 0, 0.72), 'spine'),
        'legL': ((0.1, 0, 0.55), (0.1, 0, 0.12), 'hips'),
        'legR': ((-0.1, 0, 0.55), (-0.1, 0, 0.12), 'hips'),
    }
    arm = make_armature('player_rig', bones)

    parts = []

    def P(obj, bone):
        bind_rigid(obj, bone, arm)
        parts.append(obj)
        return obj

    # 身体（衬衫锥 + 围裙前片）
    P(cone('body', (0, 0, 0.80), 0.26, 0.50, shirt, verts=12), 'spine')
    P(box('apron', (0, -0.175, 0.78), (0.30, 0.05, 0.34), apron, bevel=0.012), 'spine')
    # 头（球 + 后发）
    P(sph('head', (0, 0, 1.24), 0.22, skin, seg=12, rings=8), 'head')
    P(sph('hair', (0, 0.06, 1.27), 0.225, hair, scale=(1, 1, 0.8), seg=12, rings=8), 'head')
    # 帽（圆顶 + 帽檐）
    P(sph('hatTop', (0, 0, 1.40), 0.24, hat, scale=(1, 1, 0.55), seg=12, rings=8), 'head')
    P(cyl('brim', (0, 0, 1.33), 0.30, 0.30, 0.04, hat, verts=14), 'head')
    # 双臂（肩 → 手）
    P(tube_between('armLmesh', (0.22, 0, 1.0), (0.34, 0, 0.72), 0.07, shirt, verts=10), 'armL')
    P(tube_between('armRmesh', (-0.22, 0, 1.0), (-0.34, 0, 0.72), 0.07, shirt, verts=10), 'armR')
    P(sph('handL', (0.34, 0, 0.70), 0.075, skin, seg=8, rings=6), 'armL')
    P(sph('handR', (-0.34, 0, 0.70), 0.075, skin, seg=8, rings=6), 'armR')
    # 双腿
    P(cyl('legLmesh', (0.1, 0, 0.28), 0.075, 0.085, 0.52, dark, verts=10), 'legL')
    P(cyl('legRmesh', (-0.1, 0, 0.28), 0.075, 0.085, 0.52, dark, verts=10), 'legR')
    P(box('shoeL', (0.1, -0.03, 0.04), (0.13, 0.2, 0.08), dark, bevel=0.02), 'legL')
    P(box('shoeR', (-0.1, -0.03, 0.04), (0.13, 0.2, 0.08), dark, bevel=0.02), 'legR')

    # ---- 动画：idle 40f（呼吸+微晃）/ walk 24f（摆腿摆臂循环） ----
    idle = Anim('idle')
    idle.key(1, 'spine', rot=(0, 0, 0))
    idle.key(20, 'spine', rot=(2.5, 0, 0))
    idle.key(40, 'spine', rot=(0, 0, 0))
    idle.key(1, 'head', rot=(0, 0, 0))
    idle.key(20, 'head', rot=(-2, 0, 3))
    idle.key(40, 'head', rot=(0, 0, 0))
    idle.key(1, 'hips', loc=(0, 0, 0))
    idle.key(20, 'hips', loc=(0, 0, -0.012))
    idle.key(40, 'hips', loc=(0, 0, 0))

    walk = Anim('walk')
    walk.key(1, 'legL', rot=(-40, 0, 0))
    walk.key(13, 'legL', rot=(40, 0, 0))
    walk.key(24, 'legL', rot=(-40, 0, 0))
    walk.key(1, 'legR', rot=(40, 0, 0))
    walk.key(13, 'legR', rot=(-40, 0, 0))
    walk.key(24, 'legR', rot=(40, 0, 0))
    walk.key(1, 'armL', rot=(22, 0, 0))
    walk.key(13, 'armL', rot=(-22, 0, 0))
    walk.key(24, 'armL', rot=(22, 0, 0))
    walk.key(1, 'armR', rot=(-22, 0, 0))
    walk.key(13, 'armR', rot=(22, 0, 0))
    walk.key(24, 'armR', rot=(-22, 0, 0))
    walk.key(1, 'hips', loc=(0, 0, 0))
    walk.key(7, 'hips', loc=(0, 0, -0.02))
    walk.key(13, 'hips', loc=(0, 0, 0))
    walk.key(19, 'hips', loc=(0, 0, -0.02))
    walk.key(24, 'hips', loc=(0, 0, 0))

    finish_actions(arm)

    tris = count_tris(parts)
    print(f'[assetgen] player: {len(parts)} parts, {tris} tris, clips idle/walk')
    path = export_glb(f'{OUT_DIR}/player.glb', with_actions=True)
    print(f'[assetgen]   → {path}')


build()
