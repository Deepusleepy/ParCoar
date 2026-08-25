# Car model credits

`car_sedan.glb`, `car_sport.glb`, `car_suv.glb`

Low-poly car models by **[Quaternius](https://quaternius.com/packs/cars.html)**,
from the Cars pack, released under
[CC0](https://creativecommons.org/publicdomain/zero/1.0/). CC0 waives all
rights, so credit is not required. Credited here anyway.

Also mirrored at [Poly Pizza](https://poly.pizza/bundle/Cars-Bundle-FE5IWe6OMk).

## Truck model

`truck_quaternius.glb`

Low-poly truck model by **[Quaternius](https://quaternius.com/)**,
from [Poly Pizza](https://poly.pizza/m/cXw6oiFtZ8),
released under [CC0](https://creativecommons.org/publicdomain/zero/1.0/).
No attribution required, credited here anyway.

## How this was identified

The files were converted to glTF with `obj2gltf`, which dropped the source
metadata, so the glTF `asset` block carries no author or copyright field. The
mesh names survived the conversion and identify the pack:

```
NormalCar1_Cube.012          SportsCar2_Cube.006          SUV_Cube
NormalCar1_BackWheels_...    SportsCar2_BackWheels_...    SUV_BackWheels_...
```

The `.012` and `.006` suffixes are Blender's automatic duplicate-name
suffixes, so these were modelled in Blender rather than generated. The
Quaternius Cars pack contains a taxi, a police car, an SUV, two sports cars
and two ordinary cars, which is exactly why the names are numbered
`NormalCar1` and `SportsCar2`. Materials are flat colours with no textures
(`Blue`, `White`, `Windows`, `Black`, `Grey`, `Headlights`, `TailLights`) at
roughly 3,000 triangles each, matching that pack's style and budget.

This is an identification from the mesh names and geometry, not from a
download receipt. It is a confident match, and CC0 means there is nothing to
comply with either way, but it is worth writing down as an inference rather
than a fact.
