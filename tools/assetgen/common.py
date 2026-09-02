"""common.py — 桌游店资产管线公共助手（Blender 4.5 无头）。

坐标约定：直接在 Blender 世界系建模，对象变换尽量烘焙（transform_apply）。
  - 上 = +Z（→ three.js +Y）；正面 = -Y（→ three.js +Z，货架朝顾客一侧）。
  - 商品底面放 z=0，导出时 glTF 导出器负责 +Y up 映射。
材质约定：仅 Principled BSDF 的 BaseColor / Alpha / Emission；十六进制色先做
sRGB→线性转换（three 端 GLTFLoader 按线性读 baseColorFactor，不转会整体发白）。
运行时会整体替换为 MeshToonMaterial（保留 color / transparent / emissive）。

运行：tools/blender/blender.exe -b --factory-startup -P tools/assetgen/xxx.py
"""

import math
import os

import bpy
from mathutils import Vector


# ---------- 场景 ----------

def reset_scene():
    """清空为出厂空场景。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)


# ---------- 材质 ----------

def srgb_to_linear(c):
    """0..1 sRGB → 线性（glTF baseColorFactor 语义）。"""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(hexstr):
    """'f29ec4' / '#f29ec4' → 线性 (r, g, b)。"""
    h = hexstr.lstrip('#')
    return tuple(srgb_to_linear(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4))


def make_mat(name, hexstr, emission_hex=None, emission_strength=2.0, alpha=1.0):
    """赛璐璐低模材质：BaseColor + 可选 Emission + 可选 Alpha（4.2+ 用 surface_render_method）。"""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*hex_rgb(hexstr), 1.0)
    bsdf.inputs['Roughness'].default_value = 0.85
    bsdf.inputs['Metallic'].default_value = 0.0
    if alpha < 1.0:
        bsdf.inputs['Alpha'].default_value = alpha
        m.surface_render_method = 'BLENDED'  # 4.5 已无 blend_method
    if emission_hex:
        bsdf.inputs['Emission Color'].default_value = (*hex_rgb(emission_hex), 1.0)
        bsdf.inputs['Emission Strength'].default_value = emission_strength
    return m


# ---------- 图元（全部直接落在世界系；rot 为欧拉弧度，先缩放/旋转再 apply） ----------

def _attach(obj, name, mat, bevel):
    obj.name = name
    if mat is not None:
        obj.data.materials.append(mat)
    if bevel > 0:
        # 倒角宽自适应：小件（最小尺寸 < 3×倒角宽）会塌，自动收窄或关闭
        dims = sorted(obj.dimensions)
        w = min(bevel, dims[0] * 0.3)
        if w >= 0.004:
            mod = obj.modifiers.new('bev', 'BEVEL')
            mod.width = w
            mod.segments = 2
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier='bev')
    return obj


def box(name, loc, size, mat, bevel=0.012, rot=None):
    """轴对齐盒（rot 后不再轴对齐）。size = (x, y, z) 全尺寸。"""
    bpy.ops.mesh.primitive_cube_add(location=loc)
    o = bpy.context.active_object
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    if rot:
        o.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return _attach(o, name, mat, bevel)


def cyl(name, loc, r1, r2, h, mat, verts=12, bevel=0.0, rot=None):
    """锥形圆柱：r1=底半径 r2=顶半径，h 高（沿局部 Z）。"""
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=h, location=loc)
    o = bpy.context.active_object
    if rot:
        o.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return _attach(o, name, mat, bevel)


def cone(name, loc, r, h, mat, verts=12, rot=None):
    return cyl(name, loc, r, 0.0, h, mat, verts=verts, rot=rot)


def sph(name, loc, r, mat, scale=(1, 1, 1), seg=12, rings=8, rot=None):
    """UV 球；scale 三元组在 apply 前烘焙（先压扁再旋转，顺序正确）。"""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=seg, ring_count=rings, radius=r, location=loc)
    o = bpy.context.active_object
    o.scale = scale
    if rot:
        o.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    # 球体平滑着色
    for p in o.data.polygons:
        p.use_smooth = True
    return _attach(o, name, mat, 0.0)


def torus(name, loc, major, minor, mat, rot=None, major_seg=16, minor_seg=6):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor,
        major_segments=major_seg, minor_segments=minor_seg, location=loc,
    )
    o = bpy.context.active_object
    if rot:
        o.rotation_euler = rot
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    for p in o.data.polygons:
        p.use_smooth = True
    return _attach(o, name, mat, 0.0)


def oct(name, loc, r, mat, scale=(1, 1, 1)):
    """正八面体（宝石/星星用），scale 先烘焙。"""
    v = [(r, 0, 0), (-r, 0, 0), (0, r, 0), (0, -r, 0), (0, 0, r), (0, 0, -r)]
    f = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4),
         (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(v, [], f)
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    o.location = loc
    o.scale = scale
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.select_set(False)
    return _attach(o, name, mat, 0.0)


def tri_prism(name, loc, w, d, h, mat, rot=None):
    """实心三棱柱（6 顶 5 面）：截面为 xz 平面内底宽 w、高 h 的三角，厚 d（沿 y）。
    两面都是外法线，山墙/翼片/披檐通用。"""
    hw, hd = w / 2, d / 2
    v = [(-hw, -hd, 0), (hw, -hd, 0), (0, -hd, h),
         (-hw, hd, 0), (hw, hd, 0), (0, hd, h)]
    f = [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (0, 2, 5, 3), (1, 4, 5, 2)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(v, [], f)
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    o.location = loc
    if rot:
        o.rotation_euler = rot
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.select_set(False)
    return _attach(o, name, mat, 0.0)


def star(name, loc, r, thickness, mat, rot=None, points=5):
    """五角星薄片（星面在局部 XY，厚沿 Z；rot 把星面贴到目标法线）。"""
    outline = []
    for i in range(points * 2):
        ang = math.pi / 2 + i * math.pi / points
        rr = r if i % 2 == 0 else r * 0.45
        outline.append((rr * math.cos(ang), rr * math.sin(ang)))
    n = len(outline)
    ht = thickness / 2
    verts = [(x, y, -ht) for x, y in outline] + [(x, y, ht) for x, y in outline]
    faces = [tuple(reversed(range(n))), tuple(range(n, 2 * n))]
    for i in range(n):
        j = (i + 1) % n
        faces.append((i, j, n + j, n + i))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    o = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(o)
    o.location = loc
    if rot:
        o.rotation_euler = rot
    bpy.ops.object.select_all(action='DESELECT')
    bpy.context.view_layer.objects.active = o
    o.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    o.select_set(False)
    return _attach(o, name, mat, 0.0)


def tube_between(name, p0, p1, r, mat, verts=8):
    """两点间圆柱（支柱/手柄用）。"""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    mid = (p0 + p1) / 2
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=d.length, location=mid)
    o = bpy.context.active_object
    o.rotation_mode = 'QUATERNION'
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return _attach(o, name, mat, 0.0)


# ---------- 收尾：按材质合并 / 统计 / 导出 ----------

def join_by_material(objs, sku):
    """把部件按材质合并成每材质一个网格（draw call 收敛），命名 <sku>_<matrole>。"""
    groups = {}
    for o in objs:
        m = o.data.materials[0] if o.data.materials else None
        groups.setdefault(m, []).append(o)
    out = []
    for m, group in groups.items():
        bpy.ops.object.select_all(action='DESELECT')
        for o in group:
            o.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        if len(group) > 1:
            bpy.ops.object.join()
        act = bpy.context.active_object
        role = m.name.split('_')[-1] if m else 'nomat'
        act.name = f'{sku}_{role}'
        out.append(act)
    return out


def count_tris(objs):
    """三角面统计（ngon 三角化后计数）。"""
    total = 0
    for o in objs:
        if o.type == 'MESH':
            o.data.calc_loop_triangles()
            total += len(o.data.loop_triangles)
    return total


def add_root_empty(name, children):
    """命名根节点（运行时定位/日志用）。"""
    root = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(root)
    for c in children:
        c.parent = root
    return root


# ---------- 骨骼与动画（蒙皮角色用；赛璐璐低模刚性绑骨） ----------

def make_armature(name, bones):
    """创建骨架：bones = {骨名: (head, tail, parent|None)}，世界坐标直接给。"""
    arm = bpy.data.armatures.new(name)
    obj = bpy.data.objects.new(name, arm)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode='EDIT')
    made = {}
    for bname, (head, tail, parent) in bones.items():
        b = arm.edit_bones.new(bname)
        b.head = head
        b.tail = tail
        made[bname] = b
    for bname, (_, _, parent) in bones.items():
        if parent:
            made[bname].parent = made[parent]
    bpy.ops.object.mode_set(mode='OBJECT')
    # ★ 4.x pose 骨默认 QUATERNION 模式——rotation_euler 曲线会被忽略；
    #   强制 XYZ 欧拉模式，Anim.key / 手动 euler 赋值才生效
    for pb in obj.pose.bones:
        pb.rotation_mode = 'XYZ'
    return obj


def bind_rigid(obj, bone_name, armature_obj):
    """刚性绑骨：整网格 100% 权重绑一根骨（低模角色件用）。
    ★ 必须同时父级到骨架（否则导出器警告且 depsgraph 不求值蒙皮变形）。"""
    obj.parent = armature_obj
    mod = obj.modifiers.new('arm', 'ARMATURE')
    mod.object = armature_obj
    vg = obj.vertex_groups.new(name=bone_name)
    vg.add(list(range(len(obj.data.vertices))), 1.0, 'REPLACE')


class Anim:
    """Action 关键帧器：rot 以度记（写入时转弧度），loc 为局部偏移。"""

    def __init__(self, name):
        self.action = bpy.data.actions.new(name)

    def key(self, frame, bone, rot=None, loc=None):
        if rot is not None:
            for i in range(3):
                fc = self.action.fcurves.find(f'pose.bones["{bone}"].rotation_euler', index=i)
                if fc is None:
                    fc = self.action.fcurves.new(f'pose.bones["{bone}"].rotation_euler', index=i, action_group=bone)
                fc.keyframe_points.insert(frame, math.radians(rot[i]))
        if loc is not None:
            for i in range(3):
                fc = self.action.fcurves.find(f'pose.bones["{bone}"].location', index=i)
                if fc is None:
                    fc = self.action.fcurves.new(f'pose.bones["{bone}"].location', index=i, action_group=bone)
                fc.keyframe_points.insert(frame, loc[i])


def finish_actions(armature_obj):
    """导出前收尾：清活动 action、pose 归零、全部 action 推入静音 NLA 轨道。"""
    if armature_obj.animation_data is None:
        armature_obj.animation_data_create()
    armature_obj.animation_data.action = None
    for pb in armature_obj.pose.bones:
        pb.rotation_euler = (0, 0, 0)
        pb.location = (0, 0, 0)
    for act in bpy.data.actions:
        track = armature_obj.animation_data.nla_tracks.new()
        track.name = act.name
        strip = track.strips.new(act.name, max(1, int(act.frame_range[0])), act)
        strip.name = act.name
        track.mute = True


def export_glb(path, with_actions=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    kw = dict(filepath=path, export_format='GLB', export_yup=True)
    if with_actions:
        kw['export_animation_mode'] = 'ACTIONS'
    bpy.ops.export_scene.gltf(**kw)
    return path
