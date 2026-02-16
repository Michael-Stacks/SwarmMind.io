#include "engine.h"
#include <node_api.h>
#include <cstring>
#include <cassert>

// ============================================================
// QuadTree Implementation
// ============================================================

QuadTree::QuadTree(Rect bounds, int level)
    : bounds_(bounds), level_(level) {
    objects_.reserve(QUADTREE_MAX_OBJECTS);
}

void QuadTree::clear() {
    objects_.clear();
    if (divided_) {
        for (auto& c : children_) c.reset();
        divided_ = false;
    }
}

void QuadTree::subdivide() {
    float hw = bounds_.w * 0.5f;
    float hh = bounds_.h * 0.5f;
    float x  = bounds_.x;
    float y  = bounds_.y;

    children_[0] = std::make_unique<QuadTree>(Rect{x,      y,      hw, hh}, level_ + 1);
    children_[1] = std::make_unique<QuadTree>(Rect{x + hw, y,      hw, hh}, level_ + 1);
    children_[2] = std::make_unique<QuadTree>(Rect{x,      y + hh, hw, hh}, level_ + 1);
    children_[3] = std::make_unique<QuadTree>(Rect{x + hw, y + hh, hw, hh}, level_ + 1);
    divided_ = true;
}

void QuadTree::insert(const QTEntry& entry) {
    if (!bounds_.contains(entry.x, entry.y)) return;

    if ((int)objects_.size() < QUADTREE_MAX_OBJECTS || level_ >= QUADTREE_MAX_LEVELS) {
        objects_.push_back(entry);
        return;
    }

    if (!divided_) subdivide();

    for (auto& c : children_) {
        c->insert(entry);
    }
}

void QuadTree::query(const Rect& range, std::vector<QTEntry>& found) const {
    if (!bounds_.intersects(range)) return;

    for (auto& obj : objects_) {
        if (range.contains(obj.x, obj.y)) {
            found.push_back(obj);
        }
    }

    if (divided_) {
        for (auto& c : children_) {
            c->query(range, found);
        }
    }
}

// ============================================================
// GameEngine Implementation
// ============================================================

GameEngine::GameEngine()
    : rng_(std::random_device{}()) {
    quadTree_ = std::make_unique<QuadTree>(Rect{0, 0, MAP_WIDTH, MAP_HEIGHT});

    // Pre-spawn some resources
    for (int i = 0; i < MAX_RESOURCES / 2; ++i) {
        spawnResources();
        resourceSpawnAccum_ = 0.0f;
    }
}

Vec2 GameEngine::randomPosition() const {
    std::uniform_real_distribution<float> dx(100.0f, MAP_WIDTH - 100.0f);
    std::uniform_real_distribution<float> dy(100.0f, MAP_HEIGHT - 100.0f);
    return {dx(rng_), dy(rng_)};
}

uint32_t GameEngine::addPlayer() {
    uint32_t pid = nextPlayerId_++;
    Player p;
    p.id = pid;
    p.cursor = {MAP_WIDTH * 0.5f, MAP_HEIGHT * 0.5f};
    players_[pid] = p;
    spawnBoidsForPlayer(pid, INITIAL_BOIDS);
    return pid;
}

void GameEngine::removePlayer(uint32_t playerId) {
    players_.erase(playerId);
    // Remove all boids belonging to this player
    boids_.erase(
        std::remove_if(boids_.begin(), boids_.end(),
            [playerId](const Boid& b) { return b.playerId == playerId; }),
        boids_.end()
    );
}

void GameEngine::setPlayerCursor(uint32_t playerId, float x, float y) {
    auto it = players_.find(playerId);
    if (it != players_.end()) {
        it->second.cursor = {x, y};
    }
}

void GameEngine::setPlayerBoost(uint32_t playerId, bool active) {
    auto it = players_.find(playerId);
    if (it != players_.end()) {
        it->second.boosting = active;
    }
}

void GameEngine::spawnBoidsForPlayer(uint32_t playerId, int count) {
    Vec2 center = randomPosition();
    std::uniform_real_distribution<float> spread(-30.0f, 30.0f);
    std::uniform_real_distribution<float> vspread(-1.0f, 1.0f);

    for (int i = 0; i < count; ++i) {
        Boid b;
        b.id = nextBoidId_++;
        b.playerId = playerId;
        b.pos = {center.x + spread(rng_), center.y + spread(rng_)};
        b.vel = {vspread(rng_), vspread(rng_)};
        boids_.push_back(b);
    }
}

void GameEngine::spawnResources() {
    // Count active resources
    int activeCount = 0;
    for (auto& r : resources_) {
        if (r.active) activeCount++;
    }
    if (activeCount >= MAX_RESOURCES) return;

    std::uniform_int_distribution<int> valDist(RESOURCE_VALUE_MIN, RESOURCE_VALUE_MAX);
    std::uniform_int_distribution<int> typeDist(0, 3);

    Resource r;
    r.id = nextResourceId_++;
    r.pos = randomPosition();
    r.value = valDist(rng_);
    r.type = (uint8_t)typeDist(rng_);
    r.active = true;
    resources_.push_back(r);
}

void GameEngine::buildQuadTree() {
    quadTree_->clear();
    for (uint32_t i = 0; i < (uint32_t)boids_.size(); ++i) {
        QTEntry e;
        e.boidIndex = i;
        e.x = boids_[i].pos.x;
        e.y = boids_[i].pos.y;
        quadTree_->insert(e);
    }
}

void GameEngine::applyBoidRules() {
    float maxRadius = std::max({SEPARATION_RADIUS, ALIGNMENT_RADIUS, COHESION_RADIUS, 120.0f});
    std::vector<QTEntry> nearby;
    nearby.reserve(64);

    for (auto& boid : boids_) {
        auto pit = players_.find(boid.playerId);
        if (pit == players_.end()) continue;
        const Player& player = pit->second;
        const Mutations& mut = player.mutations;

        float effectiveCohesionRadius = COHESION_RADIUS * mut.cohesion;
        float queryR = std::max({SEPARATION_RADIUS, ALIGNMENT_RADIUS, effectiveCohesionRadius, BOID_BASE_AGGRESSION * mut.aggression});

        Rect queryRect = {
            boid.pos.x - queryR, boid.pos.y - queryR,
            queryR * 2.0f, queryR * 2.0f
        };

        nearby.clear();
        quadTree_->query(queryRect, nearby);

        Vec2 separation = {0, 0};
        Vec2 alignment  = {0, 0};
        Vec2 cohesionCenter = {0, 0};
        int  alignCount = 0;
        int  cohesionCount = 0;

        Vec2 chase = {0, 0};
        float closestEnemyDist = 1e9f;
        int closestEnemyIdx = -1;

        for (auto& ne : nearby) {
            if (ne.boidIndex == (uint32_t)(&boid - &boids_[0])) continue;

            const Boid& other = boids_[ne.boidIndex];
            Vec2 diff = boid.pos - other.pos;
            float distSq = diff.lengthSq();
            float dist = std::sqrt(distSq);

            if (other.playerId == boid.playerId) {
                // Same team — Boids rules
                if (dist < SEPARATION_RADIUS && dist > 0.01f) {
                    separation += diff * (1.0f / dist);
                }
                if (dist < ALIGNMENT_RADIUS) {
                    alignment += other.vel;
                    alignCount++;
                }
                if (dist < effectiveCohesionRadius) {
                    cohesionCenter += other.pos;
                    cohesionCount++;
                }
            } else {
                // Enemy — aggression check
                float aggroRange = BOID_BASE_AGGRESSION * mut.aggression;
                if (dist < aggroRange && dist < closestEnemyDist) {
                    closestEnemyDist = dist;
                    closestEnemyIdx = (int)ne.boidIndex;
                }
            }
        }

        Vec2 steer = {0, 0};

        // Separation
        steer += separation * SEPARATION_WEIGHT;

        // Alignment
        if (alignCount > 0) {
            alignment = alignment * (1.0f / (float)alignCount);
            Vec2 alignSteer = alignment - boid.vel;
            alignSteer.clampLength(0.5f);
            steer += alignSteer * ALIGNMENT_WEIGHT;
        }

        // Cohesion (defense)
        if (cohesionCount > 0) {
            cohesionCenter = cohesionCenter * (1.0f / (float)cohesionCount);
            Vec2 toCenter = cohesionCenter - boid.pos;
            toCenter.clampLength(0.5f);
            steer += toCenter * (COHESION_WEIGHT * mut.cohesion);
        }

        // Cursor attraction
        Vec2 toCursor = player.cursor - boid.pos;
        float cursorDist = toCursor.length();
        if (cursorDist > 5.0f) {
            toCursor = toCursor.normalized();
            steer += toCursor * CURSOR_WEIGHT;
        }

        // Chase enemy
        if (closestEnemyIdx >= 0) {
            Vec2 toEnemy = boids_[closestEnemyIdx].pos - boid.pos;
            toEnemy = toEnemy.normalized();
            steer += toEnemy * (1.5f * mut.aggression);
        }

        // Apply steering
        boid.vel += steer;

        float maxSpeed = BOID_BASE_SPEED * mut.speed;
        // Boost: multiply speed if player is boosting and has fuel
        if (player.boosting && player.boostFuel > 0.0f) {
            maxSpeed *= BOOST_SPEED_MULT;
        }
        // Speed burst pickup effect
        if (player.speedBurstTicks > 0) {
            maxSpeed *= SPEED_BURST_MULT;
        }
        // Slow trap effect
        if (player.slowTicks > 0) {
            maxSpeed *= SLOW_MULT;
        }
        boid.vel.clampLength(maxSpeed);

        boid.pos += boid.vel;
    }
}

void GameEngine::collectResources() {
    for (auto& res : resources_) {
        if (!res.active) continue;

        // Query nearby boids
        float maxRange = BOID_BASE_COLLECT_RANGE * 3.0f; // max possible
        Rect queryRect = {
            res.pos.x - maxRange, res.pos.y - maxRange,
            maxRange * 2.0f, maxRange * 2.0f
        };

        std::vector<QTEntry> nearby;
        quadTree_->query(queryRect, nearby);

        for (auto& ne : nearby) {
            const Boid& b = boids_[ne.boidIndex];
            auto pit = players_.find(b.playerId);
            if (pit == players_.end()) continue;

            float collectRange = BOID_BASE_COLLECT_RANGE * pit->second.mutations.collectRange;
            Vec2 diff = b.pos - res.pos;
            if (diff.lengthSq() < collectRange * collectRange) {
                // Consume resource
                res.active = false;
                Player& player = pit->second;
                player.score += res.value;

                // Apply mutation based on type
                float boost = 0.02f * res.value;
                switch (res.type) {
                    case 0: player.mutations.speed        += boost; break;
                    case 1: player.mutations.cohesion      += boost; break;
                    case 2: player.mutations.aggression    += boost; break;
                    case 3: player.mutations.collectRange  += boost; break;
                }

                // Possibly spawn a new boid
                int boidCount = 0;
                for (auto& bb : boids_) {
                    if (bb.playerId == player.id) boidCount++;
                }
                if (boidCount < MAX_BOIDS_PER_PLAYER && player.score % 3 == 0) {
                    Boid nb;
                    nb.id = nextBoidId_++;
                    nb.playerId = player.id;
                    nb.pos = b.pos;
                    nb.vel = {0, 0};
                    boids_.push_back(nb);
                }

                break; // Resource consumed, stop checking boids
            }
        }
    }

    // Remove inactive resources
    resources_.erase(
        std::remove_if(resources_.begin(), resources_.end(),
            [](const Resource& r) { return !r.active; }),
        resources_.end()
    );
}

void GameEngine::handleCombat() {
    // For each boid, check if an enemy boid is within COMBAT_ABSORB_RADIUS
    // The player with more boids wins the encounter
    std::vector<uint32_t> toRemove;

    // Count boids per player
    std::unordered_map<uint32_t, int> boidCounts;
    for (auto& b : boids_) {
        boidCounts[b.playerId]++;
    }

    float combatRadiusSq = COMBAT_ABSORB_RADIUS * COMBAT_ABSORB_RADIUS;

    for (uint32_t i = 0; i < (uint32_t)boids_.size(); ++i) {
        Rect queryRect = {
            boids_[i].pos.x - COMBAT_ABSORB_RADIUS,
            boids_[i].pos.y - COMBAT_ABSORB_RADIUS,
            COMBAT_ABSORB_RADIUS * 2.0f,
            COMBAT_ABSORB_RADIUS * 2.0f
        };

        std::vector<QTEntry> nearby;
        quadTree_->query(queryRect, nearby);

        for (auto& ne : nearby) {
            if (ne.boidIndex == i) continue;
            const Boid& other = boids_[ne.boidIndex];
            if (other.playerId == boids_[i].playerId) continue;

            Vec2 diff = boids_[i].pos - other.pos;
            if (diff.lengthSq() < combatRadiusSq) {
                // The smaller swarm loses this boid
                int myCount    = boidCounts[boids_[i].playerId];
                int otherCount = boidCounts[other.playerId];

                // Shield protection
                auto myPlayer = players_.find(boids_[i].playerId);
                auto otherPlayer = players_.find(other.playerId);
                bool myShield = (myPlayer != players_.end() && myPlayer->second.shieldTicks > 0);
                bool otherShield = (otherPlayer != players_.end() && otherPlayer->second.shieldTicks > 0);

                if (myCount < otherCount && !myShield) {
                    toRemove.push_back(i);
                    boidCounts[boids_[i].playerId]--;
                    break;
                } else if (otherCount < myCount && !otherShield) {
                    toRemove.push_back(ne.boidIndex);
                    boidCounts[other.playerId]--;
                }
                // If equal, no one dies
            }
        }
    }

    // Sort and remove duplicates
    std::sort(toRemove.begin(), toRemove.end());
    toRemove.erase(std::unique(toRemove.begin(), toRemove.end()), toRemove.end());

    // Remove from back to front
    for (int i = (int)toRemove.size() - 1; i >= 0; --i) {
        uint32_t idx = toRemove[i];
        if (idx < boids_.size()) {
            boids_.erase(boids_.begin() + idx);
        }
    }
}

void GameEngine::clampPositions() {
    for (auto& b : boids_) {
        if (b.pos.x < 0)          { b.pos.x = 0;          b.vel.x *= -0.5f; }
        if (b.pos.x > MAP_WIDTH)  { b.pos.x = MAP_WIDTH;  b.vel.x *= -0.5f; }
        if (b.pos.y < 0)          { b.pos.y = 0;          b.vel.y *= -0.5f; }
        if (b.pos.y > MAP_HEIGHT) { b.pos.y = MAP_HEIGHT;  b.vel.y *= -0.5f; }
    }
}

void GameEngine::spawnPickups() {
    int activeCount = 0;
    for (auto& p : pickups_) {
        if (p.active) activeCount++;
    }
    if (activeCount >= MAX_PICKUPS) return;

    pickupSpawnAccum_ += 1.0f;
    if (pickupSpawnAccum_ < PICKUP_SPAWN_INTERVAL) return;
    pickupSpawnAccum_ = 0.0f;

    std::uniform_int_distribution<int> typeDist(0, 7);
    Pickup p;
    p.id = nextPickupId_++;
    p.pos = randomPosition();
    p.type = (uint8_t)typeDist(rng_);
    p.active = true;
    pickups_.push_back(p);
}

void GameEngine::collectPickups() {
    float radiusSq = PICKUP_COLLECT_RADIUS * PICKUP_COLLECT_RADIUS;

    for (auto& pickup : pickups_) {
        if (!pickup.active) continue;

        // Query nearby boids
        Rect queryRect = {
            pickup.pos.x - PICKUP_COLLECT_RADIUS, pickup.pos.y - PICKUP_COLLECT_RADIUS,
            PICKUP_COLLECT_RADIUS * 2.0f, PICKUP_COLLECT_RADIUS * 2.0f
        };

        std::vector<QTEntry> nearby;
        quadTree_->query(queryRect, nearby);

        for (auto& ne : nearby) {
            const Boid& b = boids_[ne.boidIndex];
            Vec2 diff = b.pos - pickup.pos;
            if (diff.lengthSq() >= radiusSq) continue;

            auto pit = players_.find(b.playerId);
            if (pit == players_.end()) continue;
            Player& player = pit->second;

            pickup.active = false;

            switch (pickup.type) {
                case 0: // BOOST_REFILL
                    player.boostFuel = 1.0f;
                    break;
                case 1: { // MASS_SPAWN — gain 5 boids
                    int boidCount = 0;
                    for (auto& bb : boids_) {
                        if (bb.playerId == player.id) boidCount++;
                    }
                    int toSpawn = std::min(5, MAX_BOIDS_PER_PLAYER - boidCount);
                    if (toSpawn > 0) {
                        std::uniform_real_distribution<float> spread(-20.0f, 20.0f);
                        for (int i = 0; i < toSpawn; ++i) {
                            Boid nb;
                            nb.id = nextBoidId_++;
                            nb.playerId = player.id;
                            nb.pos = {b.pos.x + spread(rng_), b.pos.y + spread(rng_)};
                            nb.vel = {0, 0};
                            boids_.push_back(nb);
                        }
                    }
                    break;
                }
                case 2: // SHIELD
                    player.shieldTicks = SHIELD_DURATION;
                    break;
                case 3: // SPEED_BURST
                    player.speedBurstTicks = SPEED_BURST_DURATION;
                    break;
                case 4: // SLOW_TRAP
                    player.slowTicks = SLOW_DURATION;
                    break;
                case 5: { // SCATTER_BOMB — explode boids outward
                    for (auto& bb : boids_) {
                        if (bb.playerId != player.id) continue;
                        Vec2 dir = bb.pos - pickup.pos;
                        float d = dir.length();
                        if (d < 0.01f) dir = {1, 0};
                        else dir = dir.normalized();
                        bb.vel = dir * SCATTER_FORCE;
                    }
                    break;
                }
                case 6: // DRAIN_TRAP — empty boost fuel
                    player.boostFuel = 0.0f;
                    player.boosting = false;
                    break;
                case 7: { // MINE — kills some boids
                    int killed = 0;
                    for (int bi = (int)boids_.size() - 1; bi >= 0 && killed < MINE_KILL_COUNT; --bi) {
                        if (boids_[bi].playerId == player.id) {
                            boids_.erase(boids_.begin() + bi);
                            killed++;
                        }
                    }
                    break;
                }
            }
            break; // Pickup consumed
        }
    }

    // Remove inactive pickups
    pickups_.erase(
        std::remove_if(pickups_.begin(), pickups_.end(),
            [](const Pickup& p) { return !p.active; }),
        pickups_.end()
    );
}

void GameEngine::tickPlayerEffects() {
    for (auto& [pid, player] : players_) {
        if (player.shieldTicks > 0) player.shieldTicks--;
        if (player.speedBurstTicks > 0) player.speedBurstTicks--;
        if (player.slowTicks > 0) player.slowTicks--;
    }
}

void GameEngine::tick() {
    // 0. Update boost fuel for all players
    for (auto& [pid, player] : players_) {
        if (player.boosting && player.boostFuel > 0.0f) {
            player.boostFuel -= BOOST_DRAIN_RATE;
            if (player.boostFuel <= 0.0f) {
                player.boostFuel = 0.0f;
                player.boosting = false;
            }
        } else if (!player.boosting && player.boostFuel < 1.0f) {
            player.boostFuel += BOOST_RECHARGE_RATE;
            if (player.boostFuel > 1.0f) player.boostFuel = 1.0f;
        }
        // Can't boost below minimum
        if (player.boosting && player.boostFuel < BOOST_MIN_FUEL) {
            player.boosting = false;
        }
    }

    // 1. Tick player effects (decrement timers)
    tickPlayerEffects();

    // 2. Spawn resources
    resourceSpawnAccum_ += RESOURCE_SPAWN_RATE;
    while (resourceSpawnAccum_ >= 1.0f) {
        spawnResources();
        resourceSpawnAccum_ -= 1.0f;
    }

    // 3. Spawn pickups
    spawnPickups();

    // 4. Build spatial index
    buildQuadTree();

    // 5. Apply boid rules + steering
    applyBoidRules();

    // 6. Clamp to map bounds
    clampPositions();

    // 7. Rebuild quadtree after movement
    buildQuadTree();

    // 8. Collect resources
    collectResources();

    // 9. Collect pickups
    collectPickups();

    // 10. Handle combat
    handleCombat();

    // 11. Check for dead players (0 boids)
    for (auto& [pid, player] : players_) {
        int count = 0;
        for (auto& b : boids_) {
            if (b.playerId == pid) count++;
        }
        if (count == 0 && player.alive) {
            player.alive = false;
        }
    }
}

// ============================================================
// Binary Serialization
// ============================================================
// Format (all little-endian):
//   Header:
//     [uint16] mapWidth
//     [uint16] mapHeight
//     [uint16] numPlayers
//     [uint16] numBoids
//     [uint16] numResources
//     [uint16] numPickups
//   Per Player (numPlayers times):
//     [uint32] playerId
//     [uint16] score
//     [uint8]  alive (0/1)
//     [uint8]  boosting (0/1)
//     [float32] boostFuel
//     [float32] mutation_speed
//     [float32] mutation_cohesion
//     [float32] mutation_aggression
//     [float32] mutation_collectRange
//     [uint8]  shieldTicks
//     [uint8]  speedBurstTicks
//     [uint8]  slowTicks
//   Per Boid (numBoids times):
//     [uint32] playerId
//     [uint16] x  (integer position)
//     [uint16] y
//     [int8]   vx (velocity * 10, clamped to [-127,127])
//     [int8]   vy
//   Per Resource (numResources times):
//     [uint16] x
//     [uint16] y
//     [uint8]  type
//   Per Pickup (numPickups times):
//     [uint16] x
//     [uint16] y
//     [uint8]  type

std::vector<uint8_t> GameEngine::serializeState() const {
    size_t headerSize    = 12;                   // added numPickups u16
    size_t playerSize    = 4 + 2 + 1 + 1 + 4 + 4 * 4 + 3;  // 31 bytes per player (+3 effect bytes)
    size_t boidSize      = 4 + 2 + 2 + 1 + 1;   // 10 bytes per boid
    size_t resourceSize  = 2 + 2 + 1;            // 5 bytes per resource
    size_t pickupSize    = 2 + 2 + 1;            // 5 bytes per pickup

    int activeResources = 0;
    for (auto& r : resources_) {
        if (r.active) activeResources++;
    }

    int activePickups = 0;
    for (auto& p : pickups_) {
        if (p.active) activePickups++;
    }

    size_t totalSize = headerSize
        + players_.size() * playerSize
        + boids_.size() * boidSize
        + activeResources * resourceSize
        + activePickups * pickupSize;

    std::vector<uint8_t> buf(totalSize);
    uint8_t* ptr = buf.data();

    auto writeU16 = [&](uint16_t v) {
        memcpy(ptr, &v, 2); ptr += 2;
    };
    auto writeU32 = [&](uint32_t v) {
        memcpy(ptr, &v, 4); ptr += 4;
    };
    auto writeF32 = [&](float v) {
        memcpy(ptr, &v, 4); ptr += 4;
    };
    auto writeU8 = [&](uint8_t v) {
        *ptr++ = v;
    };
    auto writeI8 = [&](int8_t v) {
        *ptr++ = (uint8_t)v;
    };

    // Header
    writeU16((uint16_t)MAP_WIDTH);
    writeU16((uint16_t)MAP_HEIGHT);
    writeU16((uint16_t)players_.size());
    writeU16((uint16_t)boids_.size());
    writeU16((uint16_t)activeResources);
    writeU16((uint16_t)activePickups);

    // Players
    for (auto& [pid, player] : players_) {
        writeU32(pid);
        writeU16((uint16_t)std::min(player.score, 65535));
        writeU8(player.alive ? 1 : 0);
        writeU8(player.boosting ? 1 : 0);
        writeF32(player.boostFuel);
        writeF32(player.mutations.speed);
        writeF32(player.mutations.cohesion);
        writeF32(player.mutations.aggression);
        writeF32(player.mutations.collectRange);
        writeU8((uint8_t)std::min(player.shieldTicks, 255));
        writeU8((uint8_t)std::min(player.speedBurstTicks, 255));
        writeU8((uint8_t)std::min(player.slowTicks, 255));
    }

    // Boids
    for (auto& b : boids_) {
        writeU32(b.playerId);
        writeU16((uint16_t)std::clamp(b.pos.x, 0.0f, (float)UINT16_MAX));
        writeU16((uint16_t)std::clamp(b.pos.y, 0.0f, (float)UINT16_MAX));
        int vx = (int)(b.vel.x * 10.0f);
        int vy = (int)(b.vel.y * 10.0f);
        writeI8((int8_t)std::clamp(vx, -127, 127));
        writeI8((int8_t)std::clamp(vy, -127, 127));
    }

    // Resources
    for (auto& r : resources_) {
        if (!r.active) continue;
        writeU16((uint16_t)r.pos.x);
        writeU16((uint16_t)r.pos.y);
        writeU8(r.type);
    }

    // Pickups
    for (auto& p : pickups_) {
        if (!p.active) continue;
        writeU16((uint16_t)p.pos.x);
        writeU16((uint16_t)p.pos.y);
        writeU8(p.type);
    }

    return buf;
}

// ============================================================
// N-API Bindings
// ============================================================

static GameEngine* g_engine = nullptr;

// createEngine()
static napi_value NapiCreateEngine(napi_env env, napi_callback_info info) {
    if (g_engine) delete g_engine;
    g_engine = new GameEngine();

    napi_value result;
    napi_get_boolean(env, true, &result);
    return result;
}

// addPlayer() -> playerId (number)
static napi_value NapiAddPlayer(napi_env env, napi_callback_info info) {
    if (!g_engine) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }
    uint32_t pid = g_engine->addPlayer();
    napi_value result;
    napi_create_uint32(env, pid, &result);
    return result;
}

// removePlayer(playerId)
static napi_value NapiRemovePlayer(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    uint32_t pid;
    napi_get_value_uint32(env, args[0], &pid);

    if (g_engine) g_engine->removePlayer(pid);

    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

// setPlayerCursor(playerId, x, y)
static napi_value NapiSetCursor(napi_env env, napi_callback_info info) {
    size_t argc = 3;
    napi_value args[3];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    uint32_t pid;
    double x, y;
    napi_get_value_uint32(env, args[0], &pid);
    napi_get_value_double(env, args[1], &x);
    napi_get_value_double(env, args[2], &y);

    if (g_engine) g_engine->setPlayerCursor(pid, (float)x, (float)y);

    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

// setPlayerBoost(playerId, boosting)
static napi_value NapiSetBoost(napi_env env, napi_callback_info info) {
    size_t argc = 2;
    napi_value args[2];
    napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

    uint32_t pid;
    bool boosting;
    napi_get_value_uint32(env, args[0], &pid);
    napi_get_value_bool(env, args[1], &boosting);

    if (g_engine) g_engine->setPlayerBoost(pid, boosting);

    napi_value undef;
    napi_get_undefined(env, &undef);
    return undef;
}

// tick() -> ArrayBuffer with serialized state
static napi_value NapiTick(napi_env env, napi_callback_info info) {
    if (!g_engine) {
        napi_value undef;
        napi_get_undefined(env, &undef);
        return undef;
    }

    g_engine->tick();

    std::vector<uint8_t> data = g_engine->serializeState();

    napi_value arrayBuffer;
    void* bufferData;
    napi_create_arraybuffer(env, data.size(), &bufferData, &arrayBuffer);
    memcpy(bufferData, data.data(), data.size());

    return arrayBuffer;
}

// getMapSize() -> { width, height }
static napi_value NapiGetMapSize(napi_env env, napi_callback_info info) {
    napi_value obj;
    napi_create_object(env, &obj);

    napi_value w, h;
    napi_create_double(env, MAP_WIDTH, &w);
    napi_create_double(env, MAP_HEIGHT, &h);
    napi_set_named_property(env, obj, "width", w);
    napi_set_named_property(env, obj, "height", h);

    return obj;
}

// Module init
static napi_value Init(napi_env env, napi_value exports) {
    napi_property_descriptor props[] = {
        {"createEngine",   nullptr, NapiCreateEngine,  nullptr, nullptr, nullptr, napi_default, nullptr},
        {"addPlayer",      nullptr, NapiAddPlayer,     nullptr, nullptr, nullptr, napi_default, nullptr},
        {"removePlayer",   nullptr, NapiRemovePlayer,  nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setPlayerCursor",nullptr, NapiSetCursor,     nullptr, nullptr, nullptr, napi_default, nullptr},
        {"setPlayerBoost", nullptr, NapiSetBoost,      nullptr, nullptr, nullptr, napi_default, nullptr},
        {"tick",           nullptr, NapiTick,          nullptr, nullptr, nullptr, napi_default, nullptr},
        {"getMapSize",     nullptr, NapiGetMapSize,    nullptr, nullptr, nullptr, napi_default, nullptr},
    };

    napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
    return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
