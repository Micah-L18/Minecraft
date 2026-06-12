// Block and texture-atlas-tile registries.

export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  LOG: 6,
  LEAVES: 7,
  PLANKS: 8,
  COBBLE: 9,
  GLASS: 10,
  BEDROCK: 11,
  COAL_ORE: 12,
  IRON_ORE: 13,
  GOLD_ORE: 14,
  DIAMOND_ORE: 15,
  GRAVEL: 16,
  SNOW: 17,
};

export const T = {
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  LOG_SIDE: 6,
  LOG_TOP: 7,
  LEAVES: 8,
  PLANKS: 9,
  COBBLE: 10,
  GLASS: 11,
  BEDROCK: 12,
  COAL: 13,
  IRON: 14,
  GOLD: 15,
  DIAMOND: 16,
  GRAVEL: 17,
  SNOW_TOP: 18,
  SNOW_SIDE: 19,
};

const tiles = (top, bottom, side) => ({ top, bottom, side });
const block = (name, solid, opaque, t) => ({ name, solid, opaque, tiles: t });

export const BLOCKS = [
  block('Air', false, false, null),
  block('Grass', true, true, tiles(T.GRASS_TOP, T.DIRT, T.GRASS_SIDE)),
  block('Dirt', true, true, tiles(T.DIRT, T.DIRT, T.DIRT)),
  block('Stone', true, true, tiles(T.STONE, T.STONE, T.STONE)),
  block('Sand', true, true, tiles(T.SAND, T.SAND, T.SAND)),
  block('Water', false, false, tiles(T.WATER, T.WATER, T.WATER)),
  block('Log', true, true, tiles(T.LOG_TOP, T.LOG_TOP, T.LOG_SIDE)),
  block('Leaves', true, true, tiles(T.LEAVES, T.LEAVES, T.LEAVES)),
  block('Planks', true, true, tiles(T.PLANKS, T.PLANKS, T.PLANKS)),
  block('Cobblestone', true, true, tiles(T.COBBLE, T.COBBLE, T.COBBLE)),
  block('Glass', true, false, tiles(T.GLASS, T.GLASS, T.GLASS)),
  block('Bedrock', true, true, tiles(T.BEDROCK, T.BEDROCK, T.BEDROCK)),
  block('Coal Ore', true, true, tiles(T.COAL, T.COAL, T.COAL)),
  block('Iron Ore', true, true, tiles(T.IRON, T.IRON, T.IRON)),
  block('Gold Ore', true, true, tiles(T.GOLD, T.GOLD, T.GOLD)),
  block('Diamond Ore', true, true, tiles(T.DIAMOND, T.DIAMOND, T.DIAMOND)),
  block('Gravel', true, true, tiles(T.GRAVEL, T.GRAVEL, T.GRAVEL)),
  block('Snowy Grass', true, true, tiles(T.SNOW_TOP, T.DIRT, T.SNOW_SIDE)),
];
