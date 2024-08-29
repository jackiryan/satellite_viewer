#!/bin/bash

if [ $# -ne 2 ]; then
    echo "Usage: $0 <cubemap.png> <resolution>"
    exit 1
fi

input_image=$1
resolution=$2

output_prefix="sky_pos"
output_files=(
    "${output_prefix}_px.png" # Positive X
    "${output_prefix}_nx.png" # Negative X
    "${output_prefix}_py.png" # Positive Y
    "${output_prefix}_ny.png" # Negative Y
    "${output_prefix}_pz.png" # Positive Z
    "${output_prefix}_nz.png" # Negative Z
)

image_width=$(identify -format "%w" "$input_image")
image_height=$(identify -format "%h" "$input_image")

face_width=$((image_width / 4))
face_height=$((image_height / 3))

declare -a coordinates=(
    "$((2 * face_width))+$((1 * face_height))" # +X
    "$((0 * face_width))+$((1 * face_height))" # -X
    "$((1 * face_width))+$((0 * face_height))" # +Y
    "$((1 * face_width))+$((2 * face_height))" # -Y
    "$((1 * face_width))+$((1 * face_height))" # +Z
    "$((3 * face_width))+$((1 * face_height))" # -Z
)

for i in ${!output_files[@]}; do
    magick "$input_image" -crop "${face_width}x${face_height}+${coordinates[$i]}" -resize "${resolution}x${resolution}" +repage "${output_files[$i]}"
    echo "Created ${output_files[$i]}"
done

echo "Cubemap split into 6 faces successfully."