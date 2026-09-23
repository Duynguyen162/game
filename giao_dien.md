# TACTICAL MAP DESIGN SYSTEM: 40,000 TROOPS GREAT BATTLE

**Objective:** Build a massive grid-based 2D map (e.g., 512x512 tiles) using the "Tiny Swords" asset pack. The map is symmetrically divided along the vertical axis (West vs. East), simulating an *Age of Empires*-style battlefield with varied elevations, natural barriers, and stealth zones to accommodate two armies of 20,000 units each.

## 1. TERRAIN MECHANICS & INTERACTIONS
The AI/Generator must assign specific logical parameters (Colliders, Navigation Mesh/Pathfinding, Opacity) to each tile type as follows:

*   **Cliffs & Elevations:** 
    *   Created by stacking visual tiles. 
    *   **Rule:** Units ABSOLUTELY CANNOT walk through or climb directly up/down cliff faces (NavMesh = Blocked). 
    *   Movement to higher/lower ground is strictly limited to specifically placed "Ramp" or "Trail" tiles.
*   **Forests & Bushes:**
    *   *Movement Logic:* Fully passable (Speed = 1.0x).
    *   *Line of Sight (LoS) Logic:* When allied units enter the forest, the tree sprites automatically reduce opacity (e.g., Alpha = 40%) to reveal the units underneath. The tree canopy completely blocks outside vision. Enemy units hiding inside the forest remain completely invisible (stealth) until allied units enter the exact same forest zone.
*   **Rivers & Water:**
    *   *Deep Water:* Impassable (NavMesh = Blocked).
    *   *Shallows / Fords (Sand/Pebble water tiles):* Passable, but movement speed is heavily penalized (Movement Speed = 0.5x).
    *   *Bridges:* Normal movement (Speed = 1.0x). These serve as critical tactical chokepoints.
*   **Plains / Grasslands:** Free movement zone, normal speed, no inherent line-of-sight blockers.

## 2. MACRO LAYOUT & ZONES
The map is divided into 5 distinct tactical zones to ensure dynamic gameplay and strategic depth:

### Zones 1 & 2: West and East Spawn Zones (Base Camps)
*   **Location:** Occupying the outer 20% of the map on the far Left (West) and far Right (East) edges.
*   **Design:** Wide, open plains with very few obstacles. Decorated with occasional small bushes or rocks to break visual monotony.
*   **Purpose:** To provide enough open space to spawn and arrange 20,000 units per side without causing pathfinding errors or instant bottlenecks.

### Zone 3: The Great Divide (Central River)
*   **Location:** Running vertically from North to South, dividing the map in half with a natural, winding shape.
*   **Design:** 
    *   Mostly deep, impassable water.
    *   Features **3 main bridges** (wooden or stone) located at the Upper, Middle, and Lower sections of the river.
    *   Features **2 shallow ford areas** strategically placed between the bridges to allow for flanking maneuvers, at the cost of crossing speed.

### Zone 4: The Tactical Highlands
*   **Location:** Scattered along both sides of the river and in the buffer zones between the spawn areas and the center.
*   **Design:** 
    *   Built using 2 to 3 layers of stacked cliff tiles.
    *   The tops of these highlands are flat areas perfect for positioning archers or ranged units.
    *   Accessible via 1 or 2 narrow ramps. The perimeters are steep, impassable cliffs.
    *   Arranged in a zig-zag pattern to form natural valleys and heavily contested pathways below.

### Zone 5: Ambush Woods (Forest Mazes)
*   **Location:** Hugging the extreme North and South borders of the map, bleeding inward into the valleys between the highlands.
*   **Design:** 
    *   Extremely dense concentration of tree sprites.
    *   The internal structure of the woods features branching paths and massive canopies to fully utilize the stealth/opacity mechanics.
    *   Outer edges are detailed with mushrooms, dead stumps, and bushes.

## 3. IMPLEMENTATION STEPS FOR MAP GENERATOR
1.  **Grid Initialization:** Fill the entire base layer with plain Grass/Dirt tiles.
2.  **Carve Rivers:** Draw the winding central river. Place the 3 bridges and paint the shallow water fords. Assign appropriate speed modifiers to these tiles.
3.  **Build Elevations:** Stack cliff tiles to form the Highland blocks. Attach Ramp tiles to create valid pathways to the top. **Crucial:** Bake collision boxes on all exposed cliff edges to prevent pathfinding bugs.
4.  **Populate Flora:** Paint the Forest zones. Attach trigger areas to these tiles: `If Allied_Unit enters -> Set Sprite Alpha = 0.4`, `If Enemy_Unit is inside -> Set Render = False (until detected)`.
5.  **NavMesh Optimization:** Calculate the final Navigation Mesh for the entire map. Ensure that the 40,000 units will naturally funnel towards bridges, ramps, and shallows, rather than getting stuck against cliffs or deep water.