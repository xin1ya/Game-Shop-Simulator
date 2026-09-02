"""products.py — 13 个 SKU 高精度商品模型（桌游店货架陈列用）。

设计法（对齐管线 SKILL）：
  - 先剪影后特征：每个 SKU 一句剪影描述 + 3-5 个识别特征件，禁止同模板换色充数。
  - 赛璐璐低模：球 12 段/8 环，柱锥 12 段，盒件 2 段倒角（小件自动收窄/关闭）。
  - 配色 2-5 色 + 至多 1 类发光点缀；材质角色名 `m_<sku>_<role>`，
    含 glass=半透明 / ems=发光 的角色运行时**不加描边壳**。
  - 坐标：正面朝 Blender -Y（= three.js +Z 顾客侧），底面 z=0；
    陈列包络 宽 x ≤0.40 / 深 y ≤0.34 / 高 z ≤0.50（货架层距 0.55）。
  - 收尾 join_by_material：每材质一个网格 `<sku>_<role>`，挂根节点 `<sku>`。

运行：tools/blender/blender.exe -b --factory-startup -P tools/assetgen/products.py
预览由 preview_products.py exec 本文件（__name__ != '__main__' 时不导出）。
"""

import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # Blender -P / exec 双兼容

from common import (  # noqa: E402
    reset_scene, make_mat, box, cyl, cone, sph, torus, oct, tri_prism, star,
    tube_between, join_by_material, count_tris, add_root_empty, export_glb,
)

OUT_DIR = 'assets/glb'


def M(sku, role, hexstr, **kw):
    return make_mat(f'm_{sku}_{role}', hexstr, **kw)


# ================================================================
# 桌游盒三类（boardgame_low ×3 / boardgame_high ×3）
# ================================================================

def build_cat_cafe():
    """猫咖物语 —— 剪影：奶油扁盒 + 粉色盒盖竖起两只猫耳，正面爪印。"""
    sku = 'cat_cafe'
    cream = M(sku, 'body', 'f7e7cd')
    pink = M(sku, 'pink', 'f29ec4')
    deco = M(sku, 'deco', 'e07a9f')
    P = []
    P.append(box('body', (0, 0, 0.075), (0.34, 0.26, 0.15), cream, bevel=0.015))
    P.append(box('lid', (0, 0, 0.175), (0.36, 0.28, 0.05), pink, bevel=0.012))
    # 猫耳（微外撇，根部埋进盒盖 0.01）
    for sx in (-1, 1):
        P.append(cone('ear', (sx * 0.105, -0.09, 0.23), 0.05, 0.085, pink,
                      verts=10, rot=(0, sx * 0.18, 0)))
    # 正面爪印（贴在盒体 -Y 面：掌垫 + 3 趾；盒体面 y=-0.13）
    P.append(sph('pad', (0, -0.131, 0.072), 0.022, deco, scale=(1, 0.35, 0.8), seg=10, rings=6))
    for dx, dz in ((-0.032, 0.105), (0, 0.112), (0.032, 0.105)):
        P.append(sph('toe', (dx, -0.131, dz), 0.011, deco, scale=(1, 0.35, 1), seg=8, rings=6))
    return sku, P


def build_undercover():
    """谁是卧底·派对版 —— 剪影：藏青盒 + 立在盒上的放大镜。"""
    sku = 'undercover'
    navy = M(sku, 'navy', '4a5a7c')
    slate = M(sku, 'slate', '5b6b8c')
    dark = M(sku, 'dark', '3a3430')  # 镜框+手柄：深色与盒身拉开对比
    glass = M(sku, 'ems', 'bfe4f2', emission_hex='bfe4f2', emission_strength=1.5)
    P = []
    P.append(box('body', (0, 0, 0.08), (0.34, 0.26, 0.16), navy, bevel=0.015))
    P.append(box('lid', (0, 0, 0.1825), (0.355, 0.275, 0.045), slate, bevel=0.012))
    # 放大镜：环面近竖直、微后仰；手柄向前下斜插进盒盖（正面可见握柄）
    P.append(torus('ring', (0.05, -0.02, 0.27), 0.058, 0.014, dark, rot=(math.pi / 2 - 0.18, 0, 0)))
    P.append(cyl('lens', (0.05, -0.02, 0.27), 0.048, 0.048, 0.008, glass,
                 verts=16, rot=(math.pi / 2 - 0.18, 0, 0)))
    P.append(tube_between('handle', (0.05, -0.031, 0.222), (0.05, -0.078, 0.183), 0.016, dark))
    return sku, P


def build_gem_trader():
    """宝石商人·简装 —— 剪影：金盖盒 + 三颗八面体宝石 + 金币。"""
    sku = 'gem_trader'
    teal = M(sku, 'teal', '2f5d55')
    gold = M(sku, 'gold', 'd8b25c')
    emerald = M(sku, 'emerald', '35c48d')
    ruby = M(sku, 'ems', 'e0526b', emission_hex='e0526b', emission_strength=1.5)
    P = []
    P.append(box('body', (0, 0, 0.07), (0.34, 0.26, 0.14), teal, bevel=0.015))
    P.append(box('lid', (0, 0, 0.16), (0.355, 0.275, 0.04), gold, bevel=0.012))
    # 宝石簇（盖面 z=0.18 起）：大祖母绿 + 红宝石（发光）+ 小祖母绿
    P.append(oct('gemL', (-0.05, -0.02, 0.235), 0.05, emerald, scale=(1, 1, 1.5)))
    P.append(oct('gemR', (0.07, -0.05, 0.215), 0.032, ruby, scale=(1, 1, 1.3)))
    P.append(oct('gemS', (0.04, 0.06, 0.208), 0.028, emerald, scale=(1, 1, 1.2)))
    # 金币两枚
    P.append(cyl('coin1', (-0.10, 0.05, 0.186), 0.035, 0.035, 0.012, gold, verts=14))
    P.append(cyl('coin2', (-0.065, 0.085, 0.186), 0.03, 0.03, 0.012, gold, verts=14))
    return sku, P


def build_civ_rise():
    """文明兴衰·典藏 —— 剪影：大理石厚盒 + 微型神庙（三柱 + 三角楣）。"""
    sku = 'civ_rise'
    marble = M(sku, 'marble', 'f5f2ea')
    gold = M(sku, 'gold', 'e3c878')
    P = []
    P.append(box('body', (0, 0, 0.10), (0.36, 0.28, 0.20), marble, bevel=0.015))
    P.append(box('lid', (0, 0, 0.2225), (0.375, 0.29, 0.045), gold, bevel=0.012))
    P.append(box('tbase', (0, -0.03, 0.255), (0.18, 0.12, 0.02), marble, bevel=0.006))
    for dx in (-0.05, 0, 0.05):
        P.append(cyl('column', (dx, -0.03, 0.29), 0.016, 0.016, 0.09, marble, verts=10))
    P.append(tri_prism('pediment', (0, -0.03, 0.335), 0.16, 0.05, 0.05, gold))
    return sku, P


def build_deep_space():
    """深空远征 —— 剪影：藏蓝盒 + 立式火箭（发光头锥/舷窗/星）。"""
    sku = 'deep_space'
    navy = M(sku, 'navy', '2e3a55')
    steel = M(sku, 'steel', '5b6b8c')
    white = M(sku, 'white', 'f5f2ea')
    orange = M(sku, 'orange', 'e07f5c', emission_hex='e07f5c', emission_strength=1.2)
    cyan = M(sku, 'ems', '7ee0ff', emission_hex='7ee0ff', emission_strength=1.5)
    P = []
    P.append(box('body', (0, 0, 0.075), (0.34, 0.26, 0.15), navy, bevel=0.015))
    P.append(box('lid', (0, 0, 0.17), (0.355, 0.275, 0.04), steel, bevel=0.012))
    # 盒正面两颗小星（-Y 面）
    for dx, dz in ((-0.10, 0.09), (0.09, 0.115)):
        P.append(oct('star', (dx, -0.131, dz), 0.013, cyan))
    # 火箭：箭体 + 头锥 + 三尾翼 + 舷窗
    P.append(cyl('rocket', (0, 0.02, 0.29), 0.045, 0.045, 0.20, white, verts=14))
    P.append(cone('nose', (0, 0.02, 0.43), 0.045, 0.08, orange, verts=14))
    for k in range(3):
        t = math.radians(k * 120)
        P.append(tri_prism('fin', (0.045 * math.cos(t), 0.02 + 0.045 * math.sin(t), 0.20),
                           0.055, 0.015, 0.07, orange, rot=(0, 0, t)))
    P.append(sph('porthole', (0, -0.026, 0.31), 0.016, cyan, seg=10, rings=6))
    return sku, P


def build_dragon_exp():
    """龙与地下城·扩展包 —— 剪影：墨绿盒金盖 + 幼龙（翅膀/角/尾）。"""
    sku = 'dragon_exp'
    deep = M(sku, 'deep', '2f5d3a')
    gold = M(sku, 'gold', 'e3c878')
    green = M(sku, 'green', '58b368')
    purple = M(sku, 'purple', '9b7ede')
    eyes = M(sku, 'ems', 'fff3dd', emission_hex='fff3dd', emission_strength=2.0)
    P = []
    P.append(box('body', (0, 0, 0.08), (0.35, 0.27, 0.16), deep, bevel=0.015))
    P.append(box('lid', (0, 0, 0.18), (0.365, 0.28, 0.04), gold, bevel=0.012))
    # 幼龙（盖面 0.20 起，面朝 -Y）：身 → 颈 → 头 + 吻 + 角 + 翼 + 尾
    P.append(sph('dbody', (0, 0.03, 0.27), 0.075, green, scale=(1, 1.3, 0.9)))
    P.append(tube_between('neck', (0, -0.03, 0.29), (0, -0.09, 0.365), 0.028, green, verts=10))
    P.append(sph('head', (0, -0.105, 0.38), 0.038, green, scale=(1, 1.25, 0.9)))
    P.append(cone('snout', (0, -0.152, 0.375), 0.018, 0.05, green, verts=8, rot=(-math.pi / 2, 0, 0)))
    for sx in (-1, 1):
        P.append(cone('horn', (sx * 0.02, -0.08, 0.415), 0.008, 0.032, gold, verts=6))
        P.append(tri_prism('wing', (sx * 0.07, 0.055, 0.26), 0.13, 0.014, 0.12,
                           purple, rot=(0, -sx * 0.5, sx * 0.12)))
        P.append(sph('eye', (sx * 0.018, -0.137, 0.392), 0.007, eyes, seg=8, rings=6))
    P.append(cone('tail', (0, 0.135, 0.245), 0.025, 0.10, green, verts=8, rot=(1.15, 0, 0)))
    return sku, P


# ================================================================
# 饮品零食三类（snacks ×3）
# ================================================================

def build_boba_tea():
    """珍珠奶茶 —— 剪影：透明杯身透出奶茶与杯底珍珠，拱盖 + 粗吸管。"""
    sku = 'boba_tea'
    glass = M(sku, 'glass', 'ffffff', alpha=0.35)
    tea = M(sku, 'tea', 'd8a86a')
    pearl = M(sku, 'pearl', '3a2a1a')
    pink = M(sku, 'pink', 'f29ec4')
    straw = M(sku, 'straw', 'e05252')
    P = []
    P.append(cyl('cup', (0, 0, 0.11), 0.075, 0.095, 0.22, glass, verts=16))
    P.append(cyl('tea', (0, 0, 0.1025), 0.068, 0.086, 0.185, tea, verts=16))
    # 珍珠贴杯壁（半透出奶茶层，透过透明杯可见；中间沉一颗）
    for px, py, pz in ((0.055, 0, 0.03), (-0.05, 0.02, 0.045), (0.02, -0.055, 0.035),
                       (-0.02, 0.05, 0.06), (0.005, 0.01, 0.028)):
        P.append(sph('pearl', (px, py, pz), 0.023, pearl, seg=10, rings=6))
    P.append(cyl('band', (0, 0, 0.115), 0.0795, 0.0885, 0.045, pink, verts=16))
    P.append(sph('dome', (0, 0, 0.22), 0.095, glass, scale=(1, 1, 0.55), seg=16, rings=8))
    P.append(cyl('straw', (0.02, 0, 0.32), 0.016, 0.016, 0.17, straw, verts=8, rot=(0.15, 0, 0.1)))
    return sku, P


def build_hand_brew():
    """手冲咖啡 —— 剪影：侧柄马克杯 + 咖啡面 + 奶泡 + 碟。"""
    sku = 'hand_brew'
    cream = M(sku, 'cream', 'f3e2c2')
    white = M(sku, 'white', 'f5f2ea')
    coffee = M(sku, 'coffee', '6b4a2f')
    foam = M(sku, 'foam', 'fff3dd')
    P = []
    P.append(cyl('saucer', (0, 0, 0.0125), 0.13, 0.11, 0.025, cream, verts=16))
    P.append(cyl('mug', (0, 0, 0.10), 0.075, 0.085, 0.15, white, verts=14))
    P.append(cyl('coffee', (0, 0, 0.172), 0.072, 0.072, 0.012, coffee, verts=14))
    P.append(sph('foam', (-0.012, -0.008, 0.177), 0.03, foam, scale=(1, 0.75, 0.15), seg=10, rings=6))
    # 侧柄（+X 侧竖环，环面 XZ，内缘埋进杯身）
    P.append(torus('handle', (0.115, 0, 0.10), 0.042, 0.013, white, rot=(math.pi / 2, 0, 0)))
    return sku, P


def build_energy_bar():
    """桌游夜能量棒 —— 剪影：巧克力排（6 格凸起）右半包红锡纸。"""
    sku = 'energy_bar'
    choc = M(sku, 'choc', '6b4a2f')
    bump = M(sku, 'bump', '7d5638')
    wrap = M(sku, 'wrap', 'e05252')
    band = M(sku, 'band', 'f3e2c2')
    P = []
    P.append(box('bar', (0, 0, 0.0225), (0.30, 0.13, 0.045), choc, bevel=0.008))
    for dx in (-0.095, 0, 0.095):
        for dy in (-0.0325, 0.0325):
            P.append(box('bump', (dx, dy, 0.051), (0.085, 0.05, 0.018), bump, bevel=0.006))
    # 锡纸套（右半）+ 奶油色撕口边
    P.append(box('wrapper', (0.085, 0, 0.0325), (0.15, 0.14, 0.065), wrap, bevel=0.008))
    P.append(box('wband', (0.015, 0, 0.0325), (0.03, 0.145, 0.07), band, bevel=0.006))
    return sku, P


# ================================================================
# 周边四类（merch ×4）
# ================================================================

def build_dice_keychain():
    """骰子钥匙扣 —— 剪影：圆角骰子（三面点）+ 立起的金钥匙圈。"""
    sku = 'dice_keychain'
    white = M(sku, 'white', 'f5f2ea')
    dark = M(sku, 'dark', '3a3430')
    gold = M(sku, 'gold', 'd8b25c')
    P = []
    P.append(box('die', (0, 0, 0.075), (0.15, 0.15, 0.15), white, bevel=0.02))
    # 顶面 5 点 / 正面(-Y) 2 点 / 右面 1 点（贴片半球嵌入面内）
    for dx, dy in ((-0.035, -0.035), (0.035, -0.035), (0, 0), (-0.035, 0.035), (0.035, 0.035)):
        P.append(sph('pipT', (dx, dy, 0.151), 0.011, dark, scale=(1, 1, 0.35), seg=8, rings=6))
    for dx, dz in ((-0.03, 0.105), (0.03, 0.045)):
        P.append(sph('pipF', (dx, -0.076, dz), 0.011, dark, scale=(1, 0.35, 1), seg=8, rings=6))
    P.append(sph('pipR', (0.076, 0, 0.075), 0.011, dark, scale=(0.35, 1, 1), seg=8, rings=6))
    # 连接柱 + 竖立钥匙圈（环面 XZ）
    P.append(cyl('link', (0, 0.045, 0.175), 0.012, 0.012, 0.05, gold, verts=8))
    P.append(torus('ring', (0, 0.045, 0.245), 0.055, 0.012, gold, rot=(math.pi / 2, 0, 0)))
    return sku, P


def build_sticker_pack():
    """主题贴纸包 —— 剪影：木托底座 + 斜靠背卡 + 三张扇形贴纸页。"""
    sku = 'sticker_pack'
    wood = M(sku, 'wood', 'a8703a')
    kraft = M(sku, 'kraft', 'e8c88f')
    pink = M(sku, 'pink', 'f29ec4')
    blue = M(sku, 'blue', '7ec8e3')
    mint = M(sku, 'mint', 'a8d8b0')
    P = []
    P.append(box('tray', (0, 0, 0.0175), (0.28, 0.12, 0.035), wood, bevel=0.008))
    P.append(box('card', (0, 0.03, 0.165), (0.24, 0.015, 0.30), kraft, bevel=0.006, rot=(-0.2, 0, 0)))
    # 扇形三页（前倾角递减，形成扇面）
    P.append(box('sheet1', (0, -0.005, 0.15), (0.20, 0.008, 0.24), pink, bevel=0.004, rot=(-0.14, 0, 0)))
    P.append(box('sheet2', (0, -0.02, 0.145), (0.20, 0.008, 0.24), blue, bevel=0.004, rot=(-0.10, 0, 0)))
    P.append(box('sheet3', (0, -0.035, 0.14), (0.20, 0.008, 0.24), mint, bevel=0.004, rot=(-0.06, 0, 0)))
    return sku, P


def build_metal_badge():
    """金属徽章·限定 —— 剪影：展示架斜托金徽章，中央发光星。"""
    sku = 'metal_badge'
    dark = M(sku, 'dark', '3a3430')
    gold = M(sku, 'gold', 'e3c878')
    star_mat = M(sku, 'ems', 'fff3dd', emission_hex='fff3dd', emission_strength=2.0)
    P = []
    P.append(box('stand', (0, 0, 0.02), (0.17, 0.09, 0.04), dark, bevel=0.008))
    P.append(box('rest', (0, 0.035, 0.07), (0.17, 0.02, 0.10), dark, bevel=0.006, rot=(0.35, 0, 0)))
    # 徽章前倾 20° 靠在背托上（面朝上前方）；五角星嵌在章面上
    P.append(cyl('badge', (0, 0.0, 0.115), 0.088, 0.088, 0.022, gold, verts=20, rot=(0.35, 0, 0)))
    P.append(torus('rim', (0, 0.0, 0.115), 0.088, 0.008, gold, rot=(0.35, 0, 0)))
    P.append(star('star', (0, -0.0095, 0.127), 0.032, 0.012, star_mat, rot=(0.35, 0, 0)))
    return sku, P


def build_dice_tower():
    """限定骰塔 —— 剪影：石塔 + 城垛 + 前出骰口 + 木托盘含一颗骰子。"""
    sku = 'dice_tower'
    stone = M(sku, 'stone', '8c96a8')
    dark = M(sku, 'darkstone', '5b6b8c')
    hole = M(sku, 'hole', '3a3430')
    wood = M(sku, 'wood', 'a8703a')
    white = M(sku, 'white', 'f5f2ea')
    P = []
    P.append(box('tower', (0, 0, 0.19), (0.19, 0.19, 0.38), stone, bevel=0.012))
    P.append(box('rim', (0, 0, 0.395), (0.21, 0.21, 0.03), dark, bevel=0.008))
    for sx in (-1, 1):
        for sy in (-1, 1):
            P.append(box('crenel', (sx * 0.0725, sy * 0.0725, 0.43),
                         (0.045, 0.045, 0.04), dark, bevel=0.006))
    P.append(box('tophole', (0, 0, 0.402), (0.11, 0.11, 0.02), hole, bevel=0.0))
    # 前出骰口（-Y 面暗口）
    P.append(box('slot', (0, -0.096, 0.09), (0.10, 0.02, 0.09), hole, bevel=0.0))
    # 托盘 + 三面围栏（前缘 -Y）
    P.append(box('tray', (0, -0.16, 0.015), (0.24, 0.16, 0.03), wood, bevel=0.006))
    P.append(box('railF', (0, -0.2325, 0.0375), (0.24, 0.015, 0.05), wood, bevel=0.004))
    for sx in (-1, 1):
        P.append(box('railS', (sx * 0.1125, -0.16, 0.0375), (0.015, 0.16, 0.05), wood, bevel=0.004))
    # 托盘里的骰子（旋转 23° 摆随意感）+ 顶面一点
    P.append(box('die', (0.04, -0.16, 0.065), (0.07, 0.07, 0.07), white, bevel=0.01, rot=(0, 0, 0.4)))
    P.append(sph('pip', (0.04, -0.16, 0.101), 0.01, hole, scale=(1, 1, 0.35), seg=8, rings=6))
    return sku, P


# ================================================================

def build_merch_bin():
    """周边置物盒（陈列容器，非卖品）—— 剪影：梯形敞口木盒（低前挡 + 高背板）。
    内部容积 0.30×0.24，小样坐盒内 z≈0.04。"""
    sku = 'merch_bin'
    wood = M(sku, 'wood', 'a8703a')
    dark = M(sku, 'dark', '8a5a2b')
    P = []
    P.append(box('bottom', (0, 0, 0.015), (0.34, 0.28, 0.03), wood, bevel=0.006))
    P.append(box('back', (0, 0.13, 0.08), (0.34, 0.025, 0.16), dark, bevel=0.006))
    P.append(box('front', (0, -0.13, 0.035), (0.34, 0.025, 0.07), dark, bevel=0.006))
    for sx in (-1, 1):
        P.append(box('side', (sx * 0.1575, 0, 0.06), (0.025, 0.26, 0.12), wood, bevel=0.006))
    return sku, P


def build_crate():
    """快递纸箱（物流容器，非卖品）—— 五面箱体 + 四片铰链盖片（完整开启动画）。
    内腔 0.50×0.50×0.44；底面 z=0。盖片挂在铰链空节点 FlapN/S/E/W 下，
    rest 姿态 = 闭合（水平盖顶）；运行时开盖目标角：FlapN/S 绕 x=-2.35、FlapE 绕 y=-2.35、FlapW 绕 y=+2.35（外下翻 135°）。
    SEALED 态胶带盖板由运行时加（本模型不含盖板）。"""
    sku = 'crate'
    kraft = M(sku, 'kraft', 'c99a5b')
    inner = M(sku, 'inner', 'e0b878')
    P = []
    H = 0.46  # 壁高
    T = 0.03  # 壁厚
    W = 0.56  # 外见方
    # 底板 + 四壁（内壁浅色 = 内腔可读）
    P.append(box('bottom', (0, 0, 0.02), (W, W, 0.04), kraft, bevel=0.008))
    for sy in (-1, 1):
        P.append(box('wallY', (0, sy * (W / 2 - T / 2), H / 2 + 0.04), (W, T, H), kraft, bevel=0.006))
        P.append(box('wallYin', (0, sy * (W / 2 - T - 0.005), H / 2), (W - 2 * T, 0.012, H - 0.1), inner, bevel=0.0))
    for sx in (-1, 1):
        P.append(box('wallX', (sx * (W / 2 - T / 2), 0, H / 2 + 0.04), (T, W - 2 * T, H), kraft, bevel=0.006))
        P.append(box('wallXin', (sx * (W / 2 - T - 0.005), 0, H / 2), (0.012, W - 2 * T, H - 0.1), inner, bevel=0.0))
    return sku, P, build_crate_flaps(kraft, W, H, T)


def build_crate_flaps(kraft, W, H, T):
    """四片铰链盖片：铰链空节点在箱顶缘，盖片局部坐标向箱内延伸（rest=闭合）。
    返回 [(hingeName, hingeObj)]，由 finish_sku 挂根节点。"""
    import bpy
    top = H + 0.04
    specs = [
        # (名字, 铰链位置（x, y=纵深, z=高）, 盖片局部中心（向内水平延伸）, 盖片尺寸)
        ('FlapN', (0, W / 2 - T / 2, top), (0, -0.11, 0), (0.52, 0.22, 0.02)),  # 后缘铰链沿 x
        ('FlapS', (0, -(W / 2 - T / 2), top), (0, 0.11, 0), (0.52, 0.22, 0.02)),  # 前缘铰链沿 x
        ('FlapE', (W / 2 - T / 2, 0, top), (-0.11, 0, 0), (0.22, 0.46, 0.02)),  # 右缘铰链沿 y
        ('FlapW', (-(W / 2 - T / 2), 0, top), (0.11, 0, 0), (0.22, 0.46, 0.02)),  # 左缘铰链沿 y
    ]
    out = []
    for name, hpos, flapCenter, flapSize in specs:
        hinge = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(hinge)
        hinge.location = hpos
        flap = box(f'{name}_mesh', (0, 0, 0), flapSize, kraft, bevel=0.004)
        flap.parent = hinge
        flap.location = flapCenter
        out.append(hinge)
    return out


def build_game_tray():
    """桌游托盘（陈列容器，非卖品）—— 扁平木托盘 + 绿呢内衬（桌游店质感）。"""
    sku = 'game_tray'
    wood = M(sku, 'wood', '8a5a2b')
    felt = M(sku, 'felt', '4a7d5a')
    P = []
    P.append(box('bottom', (0, 0, 0.012), (0.34, 0.28, 0.024), wood, bevel=0.006))
    P.append(box('liner', (0, 0, 0.026), (0.30, 0.24, 0.006), felt, bevel=0.0))
    P.append(box('back', (0, 0.135, 0.05), (0.34, 0.02, 0.10), wood, bevel=0.006))
    P.append(box('front', (0, -0.135, 0.03), (0.34, 0.02, 0.06), wood, bevel=0.006))
    for sx in (-1, 1):
        P.append(box('side', (sx * 0.16, 0, 0.04), (0.02, 0.26, 0.08), wood, bevel=0.006))
    return sku, P


def build_drink_tray():
    """饮品托盘（陈列容器，非卖品）—— 浅蓝灰托盘 + 4 个杯位立桩。"""
    sku = 'drink_tray'
    slate = M(sku, 'slate', '6b7c94')
    peg = M(sku, 'peg', 'f3e2c2')
    P = []
    P.append(box('bottom', (0, 0, 0.012), (0.34, 0.28, 0.024), slate, bevel=0.006))
    P.append(box('back', (0, 0.135, 0.045), (0.34, 0.02, 0.09), slate, bevel=0.006))
    P.append(box('front', (0, -0.135, 0.028), (0.34, 0.02, 0.055), slate, bevel=0.006))
    for dx in (-0.075, 0.075):
        for dy in (-0.06, 0.06):
            P.append(cyl('peg', (dx, dy, 0.05), 0.045, 0.045, 0.05, peg, verts=12))
    return sku, P


BUILDERS = {
    'cat_cafe': build_cat_cafe,
    'undercover': build_undercover,
    'gem_trader': build_gem_trader,
    'civ_rise': build_civ_rise,
    'deep_space': build_deep_space,
    'dragon_exp': build_dragon_exp,
    'boba_tea': build_boba_tea,
    'hand_brew': build_hand_brew,
    'energy_bar': build_energy_bar,
    'dice_keychain': build_dice_keychain,
    'sticker_pack': build_sticker_pack,
    'metal_badge': build_metal_badge,
    'dice_tower': build_dice_tower,
    'merch_bin': build_merch_bin,
    'crate': build_crate,
    'game_tray': build_game_tray,
    'drink_tray': build_drink_tray,
}


def finish_sku(sku, parts, outdir=None, extra_roots=None):
    """按材质合并 → 挂根节点（含铰链等额外节点） → 统计 → （可选）导出 GLB。"""
    meshes = join_by_material(parts, sku)
    add_root_empty(sku, meshes + list(extra_roots or []))
    tris = count_tris(meshes)
    for r in (extra_roots or []):
        tris += count_tris([c for c in r.children if c.type == 'MESH'])
    print(f'[assetgen] {sku}: {len(parts)} parts → {len(meshes)} meshes'
          f'{"+" + str(len(extra_roots)) + " hinges" if extra_roots else ""}, {tris} tris')
    if outdir:
        path = export_glb(f'{outdir}/{sku}.glb')
        print(f'[assetgen]   → {path}')
    return meshes


def build_all(outdir=OUT_DIR, only=None):
    for sku, fn in BUILDERS.items():
        if only and sku not in only:
            continue
        reset_scene()
        res = fn()
        sku_, parts = res[0], res[1]
        extra = res[2] if len(res) > 2 else None
        finish_sku(sku_, parts, outdir, extra)


if __name__ == '__main__':
    ONLY = None
    if '--' in sys.argv:
        ARGS = sys.argv[sys.argv.index('--') + 1:]
        if ARGS and ARGS[0] == '--only':
            ONLY = ARGS[1].split(',')
    build_all(OUT_DIR, ONLY)
