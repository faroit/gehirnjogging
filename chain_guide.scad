// Parametric one-piece bicycle chain guide concept.
// Units are millimeters. The values below are placeholders so the shape can be
// tuned once real frame, bolt, chainline, and chainring measurements are known.
//
// Open in OpenSCAD, press F5 for preview, F6 for render, then export STL.

/* [Preview] */
$fn = 96;
eps = 0.05;

function cubic_bezier_coord(a, b, c, d, t) =
    (1 - t) * (1 - t) * (1 - t) * a
    + 3 * (1 - t) * (1 - t) * t * b
    + 3 * (1 - t) * t * t * c
    + t * t * t * d;

function cubic_bezier_point(p0, p1, p2, p3, t) = [
    cubic_bezier_coord(p0[0], p1[0], p2[0], p3[0], t),
    cubic_bezier_coord(p0[1], p1[1], p2[1], p3[1], t),
    cubic_bezier_coord(p0[2], p1[2], p2[2], p3[2], t)
];

/* [Main Body] */
body_thickness = 6;
face_rib_extra = 0.8;

/* [Upper Mounting Plate] */
mount_slot_width = 11.5;
mount_hole_spacing_y = 14;
mount_slot_length = mount_hole_spacing_y;
mount_slot_center = [0, 56];
mount_slot_rim = 5;
mount_slot_cut_depth = 80;

mount_plate_width = 34;
mount_plate_margin_y = 8;
mount_plate_height = mount_slot_length + mount_slot_width + 2 * mount_plate_margin_y;
mount_plate_radius = 9;
mount_plate_center = mount_slot_center;

/* [Measured Chain Position] */
hole_to_chain_x = 35;
hole_to_chain_y = 50;
chain_x = mount_slot_center[0] + hole_to_chain_x;
chain_y = mount_slot_center[1] - hole_to_chain_y;

/* [Curved Arm] */
arm_radius = 4.8;
arm_station_thickness = 5;
guide_z_offset = 26;
arm_curve_steps = 12;
arm_curve_start = [8, mount_slot_center[1] - mount_hole_spacing_y / 2 - 5, 0];
arm_curve_control_1 = [10, mount_slot_center[1] - 24, guide_z_offset * 0.16];
arm_curve_control_2 = [24, chain_y + 18, guide_z_offset * 0.84];
arm_curve_end = [chain_x, chain_y + 7, guide_z_offset];
arm_path = [
    for (i = [0 : arm_curve_steps])
        cubic_bezier_point(
            arm_curve_start,
            arm_curve_control_1,
            arm_curve_control_2,
            arm_curve_end,
            i / arm_curve_steps
        )
];

mount_blend_radius = 7;
mount_blend_thickness = body_thickness + 2 * face_rib_extra;
mount_blend_points = [
    [-10, mount_slot_center[1] - mount_hole_spacing_y / 2 - 6, 0],
    [12, mount_slot_center[1] - mount_hole_spacing_y / 2 - 6, 0],
    arm_curve_control_1,
    [chain_x - 13, chain_y + 28, guide_z_offset * 0.42]
];

// Broad internal web that fuses the arm into the guide shoe while staying mostly
// above the chain clearance side.
joint_web_radius = 5.8;
joint_web_points = [
    [chain_x - 14, chain_y + 18, guide_z_offset * 0.68],
    [chain_x - 4, chain_y + 7, guide_z_offset],
    [chain_x + 6, chain_y + 7, guide_z_offset]
];

/* [Lower Guide Shoe] */
guide_center = [chain_x, chain_y];
guide_angle = -8;
guide_l_length = 22;
guide_l_back_height = 23;
guide_l_lip_thickness = 6;
guide_l_lip_y = 8;
// Negative flips the 90 degree lip toward the mounting side in Z.
guide_l_z_reach = -18;
guide_l_corner_radius = 4;

/* [Optional Labels] */
show_size_notes = false;


module rounded_rect_2d(size, radius, center=false) {
    x = size[0];
    y = size[1];
    tx = center ? -x / 2 : 0;
    ty = center ? -y / 2 : 0;

    translate([tx, ty])
        hull() {
            translate([radius, radius]) circle(r=radius);
            translate([x - radius, radius]) circle(r=radius);
            translate([x - radius, y - radius]) circle(r=radius);
            translate([radius, y - radius]) circle(r=radius);
        }
}

module capsule_2d(p1, p2, radius) {
    hull() {
        translate(p1) circle(r=radius);
        translate(p2) circle(r=radius);
    }
}

module thick_polyline_2d(points, radius) {
    for (i = [0 : len(points) - 2])
        capsule_2d(points[i], points[i + 1], radius);
}

module strap_station_3d(point, radius, height) {
    translate(point)
        cylinder(h=height, r=radius, center=true);
}

module thick_polyline_3d(points, radius, height) {
    for (i = [0 : len(points) - 2])
        hull() {
            strap_station_3d(points[i], radius, height);
            strap_station_3d(points[i + 1], radius, height);
        }
}

module mount_arm_blend_3d() {
    hull()
        for (p = mount_blend_points)
            strap_station_3d(p, mount_blend_radius, mount_blend_thickness);
}

module joint_web_3d() {
    hull()
        for (p = joint_web_points)
            strap_station_3d(p, joint_web_radius, arm_station_thickness);
}

module z_extrude(height) {
    linear_extrude(height=height, center=true, convexity=10)
        children();
}

module guide_pose_2d() {
    translate(guide_center)
        rotate(guide_angle)
            children();
}

module guide_pose_3d() {
    translate([guide_center[0], guide_center[1], guide_z_offset])
        rotate([0, 0, guide_angle])
            children();
}

module mounting_slot_2d(extra=0) {
    half_len = mount_slot_length / 2;
    radius = mount_slot_width / 2 + extra;

    capsule_2d(
        [mount_slot_center[0], mount_slot_center[1] - half_len],
        [mount_slot_center[0], mount_slot_center[1] + half_len],
        radius
    );
}

module x_bar(point, length, radius) {
    translate(point)
        rotate([0, 90, 0])
            cylinder(h=length, r=radius, center=true);
}

module positive_z_l_guide_3d() {
    union() {
        translate([0, guide_l_back_height / 2, 0])
            z_extrude(body_thickness)
                rounded_rect_2d(
                    [guide_l_length, guide_l_back_height],
                    guide_l_corner_radius,
                    center=true
                );

        hull() {
            x_bar(
                [0, guide_l_lip_y, -body_thickness / 2],
                guide_l_length,
                guide_l_lip_thickness / 2
            );

            x_bar(
                [
                    0,
                    guide_l_lip_y,
                    guide_l_z_reach
                ],
                guide_l_length,
                guide_l_lip_thickness / 2
            );
        }
    }
}

module body_profile_2d() {
    union() {
        translate(mount_plate_center)
            rounded_rect_2d(
                [mount_plate_width, mount_plate_height],
                mount_plate_radius,
                center=true
            );
    }
}

module raised_reinforcement_2d() {
    union() {
        mounting_slot_2d(mount_slot_rim);
    }
}

module printed_solid() {
    union() {
        z_extrude(body_thickness)
            body_profile_2d();

        z_extrude(body_thickness + 2 * face_rib_extra)
            raised_reinforcement_2d();

        mount_arm_blend_3d();

        thick_polyline_3d(arm_path, arm_radius, arm_station_thickness);

        joint_web_3d();

        guide_pose_3d()
            positive_z_l_guide_3d();
    }
}

module cut_mount_slot() {
    z_extrude(mount_slot_cut_depth)
        mounting_slot_2d();
}

module size_notes() {
    if (show_size_notes) {
        translate([-45, -82, body_thickness / 2 + 0.2])
            linear_extrude(height=0.6)
                text(
                    str("slot ", mount_slot_width, " x ", mount_slot_length),
                    size=4,
                    halign="left",
                    valign="center"
                );

        translate([47, -82, body_thickness / 2 + 0.2])
            linear_extrude(height=0.6)
                text(
                    "open L guide",
                    size=4,
                    halign="left",
                    valign="center"
                );
    }
}

module chain_guide() {
    color("white")
        difference() {
            union() {
                printed_solid();
                size_notes();
            }

            cut_mount_slot();
        }
}

render(convexity=10)
    chain_guide();
