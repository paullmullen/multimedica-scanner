# Fusion 360 Script: Multimedica Pi 4B + Waveshare 4.3in Display Case v2
# Purpose: first-pass printable enclosure for portrait wall-mounted kiosk
# Assumptions:
# - Raspberry Pi 4B + Waveshare 4.3in HDMI display stack
# - All cables exit bottom, including power via right-angle USB-C
# - PETG print, screw-together design, no snap fits
# - Front bezel and rear shell are separate bodies
#
# How to use:
# 1. Fusion 360 > Utilities > Scripts and Add-Ins > Scripts > Create
# 2. Choose Python
# 3. Replace the generated .py contents with this file
# 4. Run script
# 5. Inspect dimensions, tweak parameters, regenerate
#
# V2 improvements over V1:
# - No MoveFeatures transforms
# - Combine operations use ObjectCollection correctly
# - Larger bottom cable chamber
# - Single wide bottom cable exit
# - Cylindrical Pi standoffs with center holes
# - Top exhaust vents and bottom intake vents
# - Wall-mount keyhole cut placeholders
# - Front bezel with screen opening

import adsk.core
import adsk.fusion
import adsk.cam
import traceback
import math

MM = 0.1  # Fusion internal length is cm. 1 mm = 0.1 cm.

def mm(value):
    return value * MM

# -------------------------
# USER PARAMETERS — EDIT THESE
# -------------------------
# Portrait screen opening estimate. Measure actual display before final print.
screen_opening_w = 67.0
screen_opening_h = 105.0

bezel = 8.0
wall = 2.6                  # PETG-friendly wall thickness
front_bezel_t = 3.0
rear_shell_depth = 31.0      # main body depth
bottom_chamber_h = 34.0      # vertical height of deeper cable chamber
bottom_chamber_extra_depth = 15.0
back_floor_t = 2.6

outer_w = screen_opening_w + 2 * bezel
outer_h = screen_opening_h + 2 * bezel
bottom_chamber_depth = rear_shell_depth + bottom_chamber_extra_depth

# Cable exit. Large and forgiving by design.
cable_exit_w = 64.0
cable_exit_h = 15.0

# Pi 4B mounting approximation. Confirm with real hardware.
pi_hole_x_spacing = 49.0
pi_hole_y_spacing = 58.0
pi_mount_center_x = 0.0
pi_mount_center_y = 2.0
standoff_d = 7.2
standoff_h = 8.0
standoff_hole_d = 2.8       # M2.5 clearance-ish. Use 3.1 for M3.

# Bezel screw pads / holes
bezel_screw_pad_d = 8.0
bezel_screw_hole_d = 3.0
bezel_screw_inset = 8.0

# Vents
vent_count = 6
vent_w = 3.2
vent_h = 18.0
vent_gap = 4.5

# Wall mount placeholders
keyhole_spacing_y = 76.0
keyhole_head_d = 7.5
keyhole_neck_w = 3.6
keyhole_neck_h = 14.0

# -------------------------
# GEOMETRY HELPERS
# -------------------------
def make_box(root, name, cx, cy, cz, sx, sy, sz):
    sketches = root.sketches
    sketch = sketches.add(root.xYConstructionPlane)
    sketch.name = name + '_profile'

    p1 = adsk.core.Point3D.create(mm(cx - sx / 2), mm(cy - sy / 2), 0)
    p2 = adsk.core.Point3D.create(mm(cx + sx / 2), mm(cy + sy / 2), 0)
    sketch.sketchCurves.sketchLines.addTwoPointRectangle(p1, p2)
    prof = sketch.profiles.item(0)

    extrudes = root.features.extrudeFeatures
    ext_input = extrudes.createInput(prof, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    z_min = cz - sz / 2
    z_max = cz + sz / 2
    ext_input.setTwoSidesExtent(
        adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(z_min))),
        adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(z_max)))
    )
    ext = extrudes.add(ext_input)
    body = ext.bodies.item(0)
    body.name = name
    return body


def make_cylinder(root, name, cx, cy, cz, diameter, height):
    sketches = root.sketches
    sketch = sketches.add(root.xYConstructionPlane)
    sketch.name = name + '_profile'
    center = adsk.core.Point3D.create(mm(cx), mm(cy), 0)
    sketch.sketchCurves.sketchCircles.addByCenterRadius(center, mm(diameter / 2))
    prof = sketch.profiles.item(0)

    extrudes = root.features.extrudeFeatures
    ext_input = extrudes.createInput(prof, adsk.fusion.FeatureOperations.NewBodyFeatureOperation)
    z_min = cz - height / 2
    z_max = cz + height / 2
    ext_input.setTwoSidesExtent(
        adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(z_min))),
        adsk.fusion.DistanceExtentDefinition.create(adsk.core.ValueInput.createByReal(mm(z_max)))
    )
    ext = extrudes.add(ext_input)
    body = ext.bodies.item(0)
    body.name = name
    return body


def combine_join(root, target, tool, keep=False):
    tools = adsk.core.ObjectCollection.create()
    tools.add(tool)
    combines = root.features.combineFeatures
    ci = combines.createInput(target, tools)
    ci.operation = adsk.fusion.FeatureOperations.JoinFeatureOperation
    ci.isKeepToolBodies = keep
    combines.add(ci)


def combine_cut(root, target, tool, keep=False):
    tools = adsk.core.ObjectCollection.create()
    tools.add(tool)
    combines = root.features.combineFeatures
    ci = combines.createInput(target, tools)
    ci.operation = adsk.fusion.FeatureOperations.CutFeatureOperation
    ci.isKeepToolBodies = keep
    combines.add(ci)


def cut_box(root, target, name, cx, cy, cz, sx, sy, sz):
    tool = make_box(root, name + '_cut_tool', cx, cy, cz, sx, sy, sz)
    combine_cut(root, target, tool)


def cut_cylinder(root, target, name, cx, cy, cz, diameter, height):
    tool = make_cylinder(root, name + '_cut_tool', cx, cy, cz, diameter, height)
    combine_cut(root, target, tool)


def join_cylinder(root, target, name, cx, cy, cz, diameter, height):
    tool = make_cylinder(root, name, cx, cy, cz, diameter, height)
    combine_join(root, target, tool)

# -------------------------
# MAIN
# -------------------------
def run(context):
    ui = None
    try:
        app = adsk.core.Application.get()
        ui = app.userInterface
        design = app.activeProduct
        if not isinstance(design, adsk.fusion.Design):
            ui.messageBox(
            "Created Multimedica Pi Display Case v2."


            "Before full print:"

            "1. Measure real display opening and update screen_opening_w/h."

            "2. Check Pi standoff alignment."

            "3. Print only the bottom cable chamber slice first."

            "4. Manually fillet cable exit edges if desired."

            "5. PETG: 3-4 walls, 15-20% infill, brim recommended."
        )
            return

        root = design.rootComponent

        # -------------------------
        # REAR SHELL
        # -------------------------
        rear = make_box(
            root,
            'rear_shell_outer_v2',
            0,
            0,
            rear_shell_depth / 2,
            outer_w,
            outer_h,
            rear_shell_depth
        )

        # Hollow main cavity, leaving back floor and side walls.
        cut_box(
            root,
            rear,
            'main_cavity',
            0,
            0,
            back_floor_t + (rear_shell_depth - back_floor_t) / 2,
            outer_w - 2 * wall,
            outer_h - 2 * wall,
            rear_shell_depth - back_floor_t + 0.5
        )

        # Add deeper bottom cable chamber as external body, then join.
        chamber = make_box(
            root,
            'bottom_cable_chamber_outer_v2',
            0,
            -outer_h / 2 + bottom_chamber_h / 2,
            bottom_chamber_depth / 2,
            outer_w,
            bottom_chamber_h,
            bottom_chamber_depth
        )
        combine_join(root, rear, chamber)

        # Hollow bottom chamber.
        cut_box(
            root,
            rear,
            'bottom_chamber_cavity',
            0,
            -outer_h / 2 + bottom_chamber_h / 2,
            back_floor_t + (bottom_chamber_depth - back_floor_t) / 2,
            outer_w - 2 * wall,
            bottom_chamber_h - 2 * wall,
            bottom_chamber_depth - back_floor_t + 0.5
        )

        # Wide bottom cable exit. Rectangular for reliability; manually fillet later.
        cut_box(
            root,
            rear,
            'wide_bottom_cable_exit',
            0,
            -outer_h / 2 - wall / 2,
            bottom_chamber_depth / 2,
            cable_exit_w,
            wall * 3,
            cable_exit_h
        )

        # -------------------------
        # VENTS
        # -------------------------
        total_vent_w = vent_count * vent_w + (vent_count - 1) * vent_gap
        start_x = -total_vent_w / 2 + vent_w / 2

        # Top exhaust vents through top wall.
        for i in range(vent_count):
            x = start_x + i * (vent_w + vent_gap)
            cut_box(
                root,
                rear,
                f'top_exhaust_vent_{i+1}',
                x,
                outer_h / 2 - wall / 2,
                rear_shell_depth / 2,
                vent_w,
                wall * 3,
                vent_h
            )

        # Bottom intake vents through bottom chamber face, split around cable exit.
        intake_y = -outer_h / 2 + 7.0
        for i, x in enumerate([-outer_w/2 + 13, -outer_w/2 + 25, outer_w/2 - 25, outer_w/2 - 13]):
            cut_box(
                root,
                rear,
                f'bottom_intake_vent_{i+1}',
                x,
                intake_y,
                bottom_chamber_depth / 2,
                vent_w,
                12.0,
                10.0
            )

        # -------------------------
        # PI STANDOFFS
        # -------------------------
        pi_holes = [
            (pi_mount_center_x - pi_hole_x_spacing/2, pi_mount_center_y - pi_hole_y_spacing/2),
            (pi_mount_center_x + pi_hole_x_spacing/2, pi_mount_center_y - pi_hole_y_spacing/2),
            (pi_mount_center_x - pi_hole_x_spacing/2, pi_mount_center_y + pi_hole_y_spacing/2),
            (pi_mount_center_x + pi_hole_x_spacing/2, pi_mount_center_y + pi_hole_y_spacing/2),
        ]
        for i, (x, y) in enumerate(pi_holes):
            join_cylinder(
                root,
                rear,
                f'pi_standoff_{i+1}',
                x,
                y,
                back_floor_t + standoff_h / 2,
                standoff_d,
                standoff_h
            )
            cut_cylinder(
                root,
                rear,
                f'pi_standoff_hole_{i+1}',
                x,
                y,
                back_floor_t + standoff_h / 2,
                standoff_hole_d,
                standoff_h + 2.0
            )

        # -------------------------
        # WALL-MOUNT KEYHOLE PLACEHOLDERS
        # These cut the rear wall. Inspect and adjust for your screw head.
        # They are intentionally simple; manually refine after first inspection.
        # -------------------------
        for i, y in enumerate([keyhole_spacing_y / 2, -keyhole_spacing_y / 2]):
            cut_cylinder(
                root,
                rear,
                f'keyhole_head_{i+1}',
                0,
                y + 4.0,
                back_floor_t / 2,
                keyhole_head_d,
                back_floor_t * 3
            )
            cut_box(
                root,
                rear,
                f'keyhole_neck_{i+1}',
                0,
                y - keyhole_neck_h / 2 + 4.0,
                back_floor_t / 2,
                keyhole_neck_w,
                keyhole_neck_h,
                back_floor_t * 3
            )

        # -------------------------
        # FRONT BEZEL
        # -------------------------
        bezel_body = make_box(
            root,
            'front_bezel_outer_v2',
            0,
            0,
            -front_bezel_t / 2,
            outer_w,
            outer_h,
            front_bezel_t
        )

        cut_box(
            root,
            bezel_body,
            'screen_opening',
            0,
            0,
            -front_bezel_t / 2,
            screen_opening_w,
            screen_opening_h,
            front_bezel_t * 3
        )

        # Bezel screw holes near corners. For v2 these are through-holes in the front bezel.
        screw_positions = [
            (-outer_w/2 + bezel_screw_inset, -outer_h/2 + bezel_screw_inset),
            ( outer_w/2 - bezel_screw_inset, -outer_h/2 + bezel_screw_inset),
            (-outer_w/2 + bezel_screw_inset,  outer_h/2 - bezel_screw_inset),
            ( outer_w/2 - bezel_screw_inset,  outer_h/2 - bezel_screw_inset),
        ]
        for i, (x, y) in enumerate(screw_positions):
            # decorative/structural pad joined to bezel
            join_cylinder(
                root,
                bezel_body,
                f'bezel_screw_pad_{i+1}',
                x,
                y,
                -front_bezel_t / 2,
                bezel_screw_pad_d,
                front_bezel_t
            )
            cut_cylinder(
                root,
                bezel_body,
                f'bezel_screw_hole_{i+1}',
                x,
                y,
                -front_bezel_t / 2,
                bezel_screw_hole_d,
                front_bezel_t * 3
            )

        # Orientation marker body; delete or suppress before final export if unwanted.
        marker = make_box(
            root,
            'BOTTOM_MARKER_delete_before_print',
            0,
            -outer_h/2 - 2.5,
            bottom_chamber_depth + 0.5,
            40,
            2,
            1
        )

        ui.messageBox(
            'Created Multimedica Pi Display Case v2.'


            'Before full print:'

            '1. Measure real display opening and update screen_opening_w/h.'

            '2. Check Pi standoff alignment.'

            '3. Print only the bottom cable chamber slice first.'

            '4. Manually fillet cable exit edges if desired.'

            '5. PETG: 3-4 walls, 15-20% infill, brim recommended.'
        )

    except Exception:
        if ui:
            ui.messageBox('Failed:{}'.format(traceback.format_exc()))
