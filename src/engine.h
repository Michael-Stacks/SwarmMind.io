#pragma once

#include <vector>
#include <unordered_map>
#include <string>
#include <cmath>
#include <cstdint>
#include <algorithm>
#include <random>
#include <memory>

// ============================================================
// Constants
// ============================================================

static constexpr float MAP_WIDTH  = 4000.0f;
static constexpr float MAP_HEIGHT = 4000.0f;

static constexpr int   MAX_BOIDS_PER_PLAYER  = 200;
static constexpr int   INITIAL_BOIDS          = 10;

static constexpr float BOID_BASE_SPEED        = 3.0f;
static constexpr float BOID_BASE_COHESION     = 1.0f;
static constexpr float BOID_BASE_AGGRESSION   = 80.0f;
static constexpr float BOID_BASE_COLLECT_RANGE= 40.0f;

static constexpr float SEPARATION_RADIUS      = 15.0f;
static constexpr float ALIGNMENT_RADIUS       = 50.0f;
static constexpr float COHESION_RADIUS         = 60.0f;

static constexpr float SEPARATION_WEIGHT      = 2.5f;
static constexpr float ALIGNMENT_WEIGHT       = 1.0f;
static constexpr float COHESION_WEIGHT         = 1.0f;
static constexpr float CURSOR_WEIGHT          = 2.0f;

static constexpr int   MAX_RESOURCES          = 300;
static constexpr float RESOURCE_SPAWN_RATE    = 0.5f;   // per tick
static constexpr int   RESOURCE_VALUE_MIN     = 1;
static constexpr int   RESOURCE_VALUE_MAX     = 3;

static constexpr float COMBAT_ABSORB_RADIUS   = 20.0f;

static constexpr float BOOST_SPEED_MULT      = 1.85f;
static constexpr float BOOST_DRAIN_RATE      = 0.04f;
static constexpr float BOOST_RECHARGE_RATE   = 0.012f;
static constexpr float BOOST_MIN_FUEL        = 0.05f;

// Pickups & Traps
static constexpr int   MAX_PICKUPS            = 20;
static constexpr float PICKUP_SPAWN_INTERVAL  = 60.0f;  // ticks between spawn attempts
static constexpr float PICKUP_COLLECT_RADIUS  = 30.0f;
static constexpr int   SHIELD_DURATION        = 60;     // ticks (3s at 20TPS)
static constexpr int   SPEED_BURST_DURATION   = 80;     // ticks (4s)
static constexpr int   SLOW_DURATION          = 60;     // ticks (3s)
static constexpr float SPEED_BURST_MULT       = 1.5f;
static constexpr float SLOW_MULT              = 0.5f;
static constexpr float SCATTER_FORCE          = 8.0f;
static constexpr int   MINE_KILL_COUNT        = 4;

static constexpr int   QUADTREE_MAX_OBJECTS   = 8;
static constexpr int   QUADTREE_MAX_LEVELS    = 6;

// ============================================================
// Vector2
// ============================================================

struct Vec2 {
    float x = 0.0f;
    float y = 0.0f;

    Vec2() = default;
    Vec2(float x_, float y_) : x(x_), y(y_) {}

    Vec2 operator+(const Vec2& o) const { return {x + o.x, y + o.y}; }
    Vec2 operator-(const Vec2& o) const { return {x - o.x, y - o.y}; }
    Vec2 operator*(float s)       const { return {x * s, y * s}; }

    Vec2& operator+=(const Vec2& o) { x += o.x; y += o.y; return *this; }
    Vec2& operator-=(const Vec2& o) { x -= o.x; y -= o.y; return *this; }

    float lengthSq() const { return x * x + y * y; }
    float length()   const { return std::sqrt(lengthSq()); }

    Vec2 normalized() const {
        float l = length();
        if (l < 0.0001f) return {0, 0};
        return {x / l, y / l};
    }

    void clampLength(float maxLen) {
        float lsq = lengthSq();
        if (lsq > maxLen * maxLen) {
            float l = std::sqrt(lsq);
            x = (x / l) * maxLen;
            y = (y / l) * maxLen;
        }
    }
};

// ============================================================
// Rect (for QuadTree)
// ============================================================

struct Rect {
    float x, y, w, h;

    bool contains(float px, float py) const {
        return px >= x && px < x + w && py >= y && py < y + h;
    }

    bool intersects(const Rect& o) const {
        return !(o.x > x + w || o.x + o.w < x ||
                 o.y > y + h || o.y + o.h < y);
    }
};

// ============================================================
// Boid
// ============================================================

struct Boid {
    uint32_t id;
    uint32_t playerId;
    Vec2 pos;
    Vec2 vel;
};

// ============================================================
// Mutations (per-player genetic attributes)
// ============================================================

struct Mutations {
    float speed      = 1.0f;
    float cohesion   = 1.0f;
    float aggression = 1.0f;
    float collectRange = 1.0f;
};

// ============================================================
// Player
// ============================================================

struct Player {
    uint32_t id;
    Vec2 cursor;
    Mutations mutations;
    int score = 0;
    bool alive = true;
    bool boosting = false;
    float boostFuel = 1.0f;

    // Temporary effects (ticks remaining, 0 = inactive)
    int shieldTicks    = 0;
    int speedBurstTicks = 0;
    int slowTicks      = 0;
};

// ============================================================
// Resource
// ============================================================

struct Resource {
    uint32_t id;
    Vec2 pos;
    int value;
    uint8_t type;    // 0=speed, 1=cohesion, 2=aggression, 3=collectRange
    bool active = true;
};

// ============================================================
// Pickup (powerups & traps on the map)
// ============================================================
// Types 0-3: GOOD (green glow)   4-7: BAD (red glow)
//   0 = BOOST_REFILL   — refills boost to 100%
//   1 = MASS_SPAWN     — instantly gain 5 boids
//   2 = SHIELD         — invincible for 3s
//   3 = SPEED_BURST    — 1.5x speed for 4s
//   4 = SLOW_TRAP      — 0.5x speed for 3s
//   5 = SCATTER_BOMB   — explodes your boids outward
//   6 = DRAIN_TRAP     — empties your boost fuel
//   7 = MINE           — kills 4 of your boids

struct Pickup {
    uint32_t id;
    Vec2 pos;
    uint8_t type;     // 0-7
    bool active = true;
};

// ============================================================
// QuadTree
// ============================================================

struct QTEntry {
    uint32_t boidIndex;
    float x, y;
};

class QuadTree {
public:
    QuadTree(Rect bounds, int level = 0);

    void clear();
    void insert(const QTEntry& entry);
    void query(const Rect& range, std::vector<QTEntry>& found) const;

private:
    void subdivide();

    Rect bounds_;
    int level_;
    std::vector<QTEntry> objects_;
    std::unique_ptr<QuadTree> children_[4];
    bool divided_ = false;
};

// ============================================================
// GameEngine
// ============================================================

class GameEngine {
public:
    GameEngine();

    uint32_t addPlayer();
    void     removePlayer(uint32_t playerId);
    void     setPlayerCursor(uint32_t playerId, float x, float y);
    void     setPlayerBoost(uint32_t playerId, bool active);

    void tick();
    std::vector<uint8_t> serializeState() const;

    const std::vector<Boid>&     getBoids()     const { return boids_; }
    const std::vector<Resource>& getResources() const { return resources_; }
    const std::unordered_map<uint32_t, Player>& getPlayers() const { return players_; }

private:
    void spawnBoidsForPlayer(uint32_t playerId, int count);
    void spawnResources();
    void spawnPickups();
    void buildQuadTree();
    void applyBoidRules();
    void collectResources();
    void collectPickups();
    void handleCombat();
    void clampPositions();
    void tickPlayerEffects();

    Vec2 randomPosition() const;

    std::unordered_map<uint32_t, Player> players_;
    std::vector<Boid>     boids_;
    std::vector<Resource> resources_;
    std::vector<Pickup>   pickups_;

    std::unique_ptr<QuadTree> quadTree_;

    uint32_t nextPlayerId_   = 1;
    uint32_t nextBoidId_     = 1;
    uint32_t nextResourceId_ = 1;
    uint32_t nextPickupId_   = 1;

    float resourceSpawnAccum_ = 0.0f;
    float pickupSpawnAccum_   = 0.0f;

    mutable std::mt19937 rng_;
};
