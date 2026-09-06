// Bath tray / shelf organizer
// Exact outside dimensions: 229 x 200 x 25 mm

$fn = 64;

tray_length = 229;
tray_depth = 200;
tray_height = 25;

corner_radius = 5;
wall_thickness = 3;
bottom_thickness = 3;
divider_thickness = 3;

finger_slot_width = 38;
finger_slot_height = 12;
finger_slot_center_z = 15;

inner_length = tray_length - 2 * wall_thickness;
inner_depth = tray_depth - 2 * wall_thickness;
compartment_width =
    (inner_length - 2 * divider_thickness) / 3;

module rounded_prism(size_x, size_y, size_z, radius) {
    linear_extrude(height = size_z)
        hull() {
            for (x = [radius, size_x - radius])
                for (y = [radius, size_y - radius])
                    translate([x, y]) circle(r = radius);
        }
}

module tray_shell() {
    difference() {
        rounded_prism(
            tray_length,
            tray_depth,
            tray_height,
            corner_radius
        );

        // Open cavity; the small overlap guarantees a clean top edge.
        translate([wall_thickness, wall_thickness, bottom_thickness])
            rounded_prism(
                inner_length,
                inner_depth,
                tray_height - bottom_thickness + 0.2,
                max(corner_radius - wall_thickness, 0.5)
            );
    }
}

module dividers() {
    for (i = [1 : 2]) {
        divider_x = wall_thickness
            + i * compartment_width
            + (i - 1) * divider_thickness;

        translate([
            divider_x,
            wall_thickness,
            bottom_thickness
        ])
            cube([
                divider_thickness,
                inner_depth,
                tray_height - bottom_thickness
            ]);
    }
}

module finger_slot() {
    slot_radius = finger_slot_height / 2;
    center_spacing = finger_slot_width - finger_slot_height;

    translate([
        tray_length / 2,
        wall_thickness / 2,
        finger_slot_center_z
    ])
        hull() {
            for (x = [-center_spacing / 2, center_spacing / 2])
                translate([x, 0, 0])
                    rotate([90, 0, 0])
                        cylinder(
                            h = wall_thickness + 4,
                            r = slot_radius,
                            center = true
                        );
        }
}

difference() {
    union() {
        tray_shell();
        dividers();
    }

    finger_slot();
}
