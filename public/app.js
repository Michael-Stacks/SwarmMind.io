// ════════════════════════════════════════════════════════════
// SwarmMind.io — Client (VFX + Audio Edition)
// ════════════════════════════════════════════════════════════

(() => {
    'use strict';

    // ── Game State ──────────────────────────────────────────
    let myPlayerId = 0;
    let mapWidth = 4000;
    let mapHeight = 4000;
    let tickRate = 20;

    let prevState = null;
    let currState = null;
    let lastStateTime = 0;
    let interpFactor = 0;

    let mouseWorldX = 0;
    let mouseWorldY = 0;

    let cameraX = 0;
    let cameraY = 0;
    const CAMERA_LERP = 0.08;

    // Screen shake
    let shakeIntensity = 0;
    let prevMyBoidCount = 0;

    // Previous mutations for flash detection
    let prevMutations = { speed: 0, cohesion: 0, aggression: 0, collectRange: 0 };

    // Frame counter for minimap throttle
    let frameCount = 0;

    // ── Color Utilities ─────────────────────────────────────

    const playerColors = {};

    function getPlayerColor(playerId) {
        if (playerColors[playerId]) return playerColors[playerId];
        const hue = (playerId * 137.508) % 360;
        playerColors[playerId] = hslToHex(hue, 85, 58);
        return playerColors[playerId];
    }

    function hslToHex(h, s, l) {
        s /= 100; l /= 100;
        const k = n => (n + h / 30) % 12;
        const a = s * Math.min(l, 1 - l);
        const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
        return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
    }

    function hexToCSS(hex) {
        return '#' + hex.toString(16).padStart(6, '0');
    }

    const RESOURCE_COLORS = [
        0x00ccff,  // speed — cyan
        0x00ff88,  // cohesion — green
        0xff4444,  // aggression — red
        0xffaa00   // collectRange — orange
    ];

    // Pickup type info: 0-3 good (green), 4-7 bad (red)
    const PICKUP_COLORS = [
        0x00ccff,  // 0 BOOST_REFILL
        0x00ff88,  // 1 MASS_SPAWN
        0x66ddff,  // 2 SHIELD
        0xffff44,  // 3 SPEED_BURST
        0xff4444,  // 4 SLOW_TRAP
        0xff6600,  // 5 SCATTER_BOMB
        0xaa00ff,  // 6 DRAIN_TRAP
        0xff0044   // 7 MINE
    ];
    const PICKUP_GOOD = [true, true, true, true, false, false, false, false];
    const PICKUP_LABELS = ['BOOST', 'SPAWN', 'SHIELD', 'SPEED', 'SLOW', 'SCATTER', 'DRAIN', 'MINE'];

    // ── Pixi.js Setup ──────────────────────────────────────

    const pixiApp = new PIXI.Application({
        view: document.getElementById('game-canvas'),
        resizeTo: window,
        backgroundColor: 0x050510,
        antialias: false,
        resolution: window.devicePixelRatio || 1,
        autoDensity: true
    });

    const worldContainer = new PIXI.Container();
    pixiApp.stage.addChild(worldContainer);

    // Layer order
    const gridGraphics = new PIXI.Graphics();
    const ambientContainer = new PIXI.Container();
    const trailContainer = new PIXI.Container();
    const connectionGraphics = new PIXI.Graphics();
    const resourceContainer = new PIXI.Container();
    const pickupContainer = new PIXI.Container();
    const boidContainer = new PIXI.Container();
    const particleContainer = new PIXI.Container();

    worldContainer.addChild(gridGraphics);
    worldContainer.addChild(ambientContainer);
    worldContainer.addChild(trailContainer);
    worldContainer.addChild(connectionGraphics);
    worldContainer.addChild(resourceContainer);
    worldContainer.addChild(pickupContainer);
    worldContainer.addChild(boidContainer);
    worldContainer.addChild(particleContainer);

    // Vignette (screen-space, stays on stage)
    const vignetteGraphics = new PIXI.Graphics();
    pixiApp.stage.addChild(vignetteGraphics);

    drawGrid();
    drawVignette();
    window.addEventListener('resize', drawVignette);

    // ── Textures ────────────────────────────────────────────

    // Triangle boid texture (oriented right, rotated by velocity angle)
    const boidTextureCache = {};

    function getBoidTexture(color) {
        if (boidTextureCache[color]) return boidTextureCache[color];
        const g = new PIXI.Graphics();
        // Glow halo
        g.beginFill(color, 0.12);
        g.drawCircle(0, 0, 8);
        g.endFill();
        // Body triangle
        g.beginFill(color, 0.9);
        g.moveTo(5, 0);
        g.lineTo(-3, -3);
        g.lineTo(-3, 3);
        g.closePath();
        g.endFill();
        // Core bright point
        g.beginFill(0xffffff, 0.6);
        g.drawCircle(2, 0, 1);
        g.endFill();
        const tex = pixiApp.renderer.generateTexture(g);
        boidTextureCache[color] = tex;
        g.destroy();
        return tex;
    }

    // Resource textures (diamond with glow)
    const resourceTextures = RESOURCE_COLORS.map(color => {
        const g = new PIXI.Graphics();
        // Outer glow
        g.beginFill(color, 0.1);
        g.drawCircle(0, 0, 10);
        g.endFill();
        // Diamond
        g.beginFill(color, 0.7);
        g.moveTo(0, -5);
        g.lineTo(5, 0);
        g.lineTo(0, 5);
        g.lineTo(-5, 0);
        g.closePath();
        g.endFill();
        // Inner bright
        g.beginFill(0xffffff, 0.4);
        g.moveTo(0, -2);
        g.lineTo(2, 0);
        g.lineTo(0, 2);
        g.lineTo(-2, 0);
        g.closePath();
        g.endFill();
        const tex = pixiApp.renderer.generateTexture(g);
        g.destroy();
        return tex;
    });

    // Pickup textures (hexagon with glow, green=good, red=bad)
    const pickupTextures = PICKUP_COLORS.map((color, idx) => {
        const g = new PIXI.Graphics();
        const isGood = PICKUP_GOOD[idx];
        const glowColor = isGood ? 0x00ff88 : 0xff3333;
        // Outer glow
        g.beginFill(glowColor, 0.15);
        g.drawCircle(0, 0, 16);
        g.endFill();
        // Hexagon body
        g.beginFill(color, 0.8);
        const sides = 6;
        const r = 8;
        g.moveTo(r, 0);
        for (let i = 1; i <= sides; i++) {
            const angle = (i / sides) * Math.PI * 2;
            g.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
        }
        g.closePath();
        g.endFill();
        // Inner bright core
        g.beginFill(0xffffff, 0.5);
        g.drawCircle(0, 0, 3);
        g.endFill();
        const tex = pixiApp.renderer.generateTexture(g);
        g.destroy();
        return tex;
    });

    // Particle texture (soft circle)
    const particleTexture = (() => {
        const g = new PIXI.Graphics();
        g.beginFill(0xffffff, 1);
        g.drawCircle(0, 0, 4);
        g.endFill();
        const tex = pixiApp.renderer.generateTexture(g);
        g.destroy();
        return tex;
    })();

    // Trail texture (smaller, softer)
    const trailTexture = (() => {
        const g = new PIXI.Graphics();
        g.beginFill(0xffffff, 0.8);
        g.drawCircle(0, 0, 2);
        g.endFill();
        const tex = pixiApp.renderer.generateTexture(g);
        g.destroy();
        return tex;
    })();

    // ── Grid ────────────────────────────────────────────────

    function drawGrid() {
        gridGraphics.clear();
        gridGraphics.lineStyle(1, 0x0d0d24, 0.6);
        const step = 100;
        for (let x = 0; x <= mapWidth; x += step) {
            gridGraphics.moveTo(x, 0);
            gridGraphics.lineTo(x, mapHeight);
        }
        for (let y = 0; y <= mapHeight; y += step) {
            gridGraphics.moveTo(0, y);
            gridGraphics.lineTo(mapWidth, y);
        }
        gridGraphics.lineStyle(2, 0x00ff88, 0.15);
        gridGraphics.drawRect(0, 0, mapWidth, mapHeight);
    }

    // ── Vignette ────────────────────────────────────────────

    function drawVignette() {
        vignetteGraphics.clear();
        const w = pixiApp.screen.width;
        const h = pixiApp.screen.height;
        // Four edge gradients using rectangles with decreasing alpha
        const layers = 6;
        for (let i = 0; i < layers; i++) {
            const alpha = 0.25 * (1 - i / layers);
            const inset = i * 30;
            vignetteGraphics.beginFill(0x000000, alpha);
            // Top
            vignetteGraphics.drawRect(0, inset, w, 30);
            // Bottom
            vignetteGraphics.drawRect(0, h - inset - 30, w, 30);
            // Left
            vignetteGraphics.drawRect(inset, 0, 30, h);
            // Right
            vignetteGraphics.drawRect(w - inset - 30, 0, 30, h);
            vignetteGraphics.endFill();
        }
    }

    // ── Particle System ─────────────────────────────────────

    const MAX_PARTICLES = 500;
    const particles = [];

    for (let i = 0; i < MAX_PARTICLES; i++) {
        const sprite = new PIXI.Sprite(particleTexture);
        sprite.anchor.set(0.5);
        sprite.visible = false;
        particleContainer.addChild(sprite);
        particles.push({
            sprite,
            x: 0, y: 0,
            vx: 0, vy: 0,
            life: 0, maxLife: 0,
            color: 0xffffff,
            scale: 1,
            active: false
        });
    }

    function spawnParticle(x, y, vx, vy, color, life, scale) {
        for (const p of particles) {
            if (!p.active) {
                p.x = x; p.y = y;
                p.vx = vx; p.vy = vy;
                p.color = color;
                p.life = life; p.maxLife = life;
                p.scale = scale || 1;
                p.active = true;
                return;
            }
        }
    }

    function spawnExplosion(x, y, color, count) {
        for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 3;
            spawnParticle(
                x, y,
                Math.cos(angle) * speed,
                Math.sin(angle) * speed,
                color, 20 + Math.random() * 15, 0.8 + Math.random() * 0.5
            );
        }
    }

    function spawnCollectEffect(x, y, color) {
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2;
            const dist = 15 + Math.random() * 10;
            spawnParticle(
                x + Math.cos(angle) * dist,
                y + Math.sin(angle) * dist,
                -Math.cos(angle) * 2,
                -Math.sin(angle) * 2,
                color, 15, 0.7
            );
        }
    }

    function updateParticles() {
        for (const p of particles) {
            if (!p.active) continue;
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.95;
            p.vy *= 0.95;
            p.life--;
            if (p.life <= 0) {
                p.active = false;
                p.sprite.visible = false;
                continue;
            }
            const t = p.life / p.maxLife;
            p.sprite.x = p.x;
            p.sprite.y = p.y;
            p.sprite.alpha = t * 0.8;
            p.sprite.scale.set(p.scale * t);
            p.sprite.tint = p.color;
            p.sprite.visible = true;
        }
    }

    // ── Trail System ────────────────────────────────────────

    const MAX_TRAILS = 300;
    const trails = [];

    for (let i = 0; i < MAX_TRAILS; i++) {
        const sprite = new PIXI.Sprite(trailTexture);
        sprite.anchor.set(0.5);
        sprite.visible = false;
        trailContainer.addChild(sprite);
        trails.push({ sprite, life: 0, maxLife: 0, active: false, color: 0 });
    }

    let trailCursor = 0;

    function spawnTrail(x, y, color) {
        const t = trails[trailCursor];
        t.sprite.x = x;
        t.sprite.y = y;
        t.color = color;
        t.life = 12;
        t.maxLife = 12;
        t.active = true;
        t.sprite.tint = color;
        t.sprite.visible = true;
        t.sprite.alpha = 0.3;
        t.sprite.scale.set(0.6);
        trailCursor = (trailCursor + 1) % MAX_TRAILS;
    }

    function updateTrails() {
        for (const t of trails) {
            if (!t.active) continue;
            t.life--;
            if (t.life <= 0) {
                t.active = false;
                t.sprite.visible = false;
                continue;
            }
            const frac = t.life / t.maxLife;
            t.sprite.alpha = frac * 0.25;
            t.sprite.scale.set(frac * 0.5);
        }
    }

    // ── Ambient Dust Particles ──────────────────────────────

    const ambientDust = [];

    for (let i = 0; i < 40; i++) {
        const sprite = new PIXI.Sprite(particleTexture);
        sprite.anchor.set(0.5);
        sprite.tint = 0x224466;
        sprite.alpha = 0.06 + Math.random() * 0.06;
        sprite.scale.set(0.3 + Math.random() * 0.5);
        const dust = {
            sprite,
            x: Math.random() * mapWidth,
            y: Math.random() * mapHeight,
            vx: (Math.random() - 0.5) * 0.2,
            vy: (Math.random() - 0.5) * 0.2
        };
        sprite.x = dust.x;
        sprite.y = dust.y;
        ambientContainer.addChild(sprite);
        ambientDust.push(dust);
    }

    function updateAmbientDust() {
        for (const d of ambientDust) {
            d.x += d.vx;
            d.y += d.vy;
            if (d.x < 0) d.x = mapWidth;
            if (d.x > mapWidth) d.x = 0;
            if (d.y < 0) d.y = mapHeight;
            if (d.y > mapHeight) d.y = 0;
            d.sprite.x = d.x;
            d.sprite.y = d.y;
        }
    }

    // ── Sprite Pools ────────────────────────────────────────

    const boidSprites = [];
    const resourceSprites = [];

    function ensureBoidSprites(count) {
        while (boidSprites.length < count) {
            const sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
            sprite.anchor.set(0.5);
            sprite.visible = false;
            boidContainer.addChild(sprite);
            boidSprites.push(sprite);
        }
    }

    function ensureResourceSprites(count) {
        while (resourceSprites.length < count) {
            const sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
            sprite.anchor.set(0.5);
            sprite.visible = false;
            resourceContainer.addChild(sprite);
            resourceSprites.push(sprite);
        }
    }

    const pickupSprites = [];

    function ensurePickupSprites(count) {
        while (pickupSprites.length < count) {
            const sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
            sprite.anchor.set(0.5);
            sprite.visible = false;
            pickupContainer.addChild(sprite);
            pickupSprites.push(sprite);
        }
    }

    // ── Binary State Parsing ────────────────────────────────

    function parseState(buffer) {
        const view = new DataView(buffer);
        let offset = 0;
        const readU16 = () => { const v = view.getUint16(offset, true); offset += 2; return v; };
        const readU32 = () => { const v = view.getUint32(offset, true); offset += 4; return v; };
        const readF32 = () => { const v = view.getFloat32(offset, true); offset += 4; return v; };
        const readU8  = () => { const v = view.getUint8(offset); offset += 1; return v; };
        const readI8  = () => { const v = view.getInt8(offset); offset += 1; return v; };

        const mw = readU16();
        const mh = readU16();
        const numPlayers = readU16();
        const numBoids = readU16();
        const numResources = readU16();
        const numPickups = readU16();

        const players = [];
        for (let i = 0; i < numPlayers; i++) {
            players.push({
                id: readU32(), score: readU16(), alive: readU8() === 1,
                boosting: readU8() === 1, boostFuel: readF32(),
                speed: readF32(), cohesion: readF32(),
                aggression: readF32(), collectRange: readF32(),
                shieldTicks: readU8(), speedBurstTicks: readU8(), slowTicks: readU8()
            });
        }

        const boids = [];
        for (let i = 0; i < numBoids; i++) {
            boids.push({
                playerId: readU32(),
                x: readU16(), y: readU16(),
                vx: readI8() / 10.0, vy: readI8() / 10.0
            });
        }

        const resources = [];
        for (let i = 0; i < numResources; i++) {
            resources.push({ x: readU16(), y: readU16(), type: readU8() });
        }

        const pickups = [];
        for (let i = 0; i < numPickups; i++) {
            pickups.push({ x: readU16(), y: readU16(), type: readU8() });
        }

        return { players, boids, resources, pickups };
    }

    // ── Event Detection (between ticks) ─────────────────────

    function detectEvents(prev, curr) {
        if (!prev || !curr) return;

        // Detect lost boids (death explosions)
        const prevByPlayer = {};
        const currByPlayer = {};
        for (const b of prev.boids) {
            if (!prevByPlayer[b.playerId]) prevByPlayer[b.playerId] = [];
            prevByPlayer[b.playerId].push(b);
        }
        for (const b of curr.boids) {
            if (!currByPlayer[b.playerId]) currByPlayer[b.playerId] = [];
            currByPlayer[b.playerId].push(b);
        }

        // Screen shake: check own boid loss
        const myPrevCount = (prevByPlayer[myPlayerId] || []).length;
        const myCurrCount = (currByPlayer[myPlayerId] || []).length;
        if (myCurrCount < myPrevCount) {
            shakeIntensity = Math.min(12, (myPrevCount - myCurrCount) * 3);
            audio.playCombat();
        }

        // Death explosions for ALL players that lost boids
        for (const pid in prevByPlayer) {
            const prevCount = prevByPlayer[pid].length;
            const currCount = (currByPlayer[pid] || []).length;
            if (currCount < prevCount) {
                // Spawn explosions at approximate positions of lost boids
                const color = getPlayerColor(parseInt(pid));
                const prevBoids = prevByPlayer[pid];
                // Pick some from the tail of the prev array as likely lost ones
                const lostCount = Math.min(prevCount - currCount, 5);
                for (let i = 0; i < lostCount; i++) {
                    const b = prevBoids[prevCount - 1 - i];
                    if (b) spawnExplosion(b.x, b.y, color, 8);
                }
            }
        }

        // Detect collected pickups
        const prevPickups = prev.pickups || [];
        const currPickups = curr.pickups || [];
        if (prevPickups.length > currPickups.length) {
            const currPSet = new Set();
            for (const p of currPickups) currPSet.add(p.x + ',' + p.y);
            for (const p of prevPickups) {
                if (!currPSet.has(p.x + ',' + p.y)) {
                    const color = PICKUP_COLORS[p.type] || 0xffffff;
                    spawnExplosion(p.x, p.y, color, 12);
                    // Play pickup SFX if near our boids
                    if (myCurrCount > 0) {
                        const myBoids = currByPlayer[myPlayerId] || prevByPlayer[myPlayerId] || [];
                        for (const b of myBoids) {
                            const dx = b.x - p.x, dy = b.y - p.y;
                            if (dx * dx + dy * dy < 100 * 100) {
                                audio.playPickup(PICKUP_GOOD[p.type]);
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Detect collected resources
        if (prev.resources.length > curr.resources.length) {
            const currSet = new Set();
            for (const r of curr.resources) currSet.add(r.x + ',' + r.y);
            let collected = 0;
            for (const r of prev.resources) {
                if (!currSet.has(r.x + ',' + r.y) && collected < 4) {
                    spawnCollectEffect(r.x, r.y, RESOURCE_COLORS[r.type] || 0xffffff);
                    collected++;
                    // Only play sound if resource was near our boids
                    if (myCurrCount > 0) {
                        const myBoids = currByPlayer[myPlayerId] || [];
                        for (const b of myBoids) {
                            const dx = b.x - r.x, dy = b.y - r.y;
                            if (dx * dx + dy * dy < 80 * 80) {
                                audio.playCollect(r.type);
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    // ── Socket.io Connection ────────────────────────────────

    const socket = io({ transports: ['websocket'] });

    socket.on('init', (data) => {
        myPlayerId = data.playerId;
        mapWidth = data.mapWidth;
        mapHeight = data.mapHeight;
        tickRate = data.tickRate;
        drawGrid();
        audio.playSpawn();
    });

    socket.on('state', (data) => {
        let buffer;
        if (data instanceof ArrayBuffer) {
            buffer = data;
        } else if (data.buffer) {
            buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        } else {
            return;
        }

        const oldState = currState;
        prevState = currState;
        currState = parseState(buffer);
        lastStateTime = performance.now();

        detectEvents(oldState, currState);
        updateHUD(currState);
        updateLeaderboard(currState);
    });

    setInterval(() => {
        if (myPlayerId) {
            socket.volatile.emit('cursor', { x: mouseWorldX, y: mouseWorldY });
        }
    }, 50);

    // ── Mouse Tracking ──────────────────────────────────────

    window.addEventListener('mousemove', (e) => {
        const rect = pixiApp.view.getBoundingClientRect();
        mouseWorldX = (e.clientX - rect.left) + cameraX;
        mouseWorldY = (e.clientY - rect.top) + cameraY;
    });

    // ── Boost Input (spacebar / right-click) ────────────────

    let isBoosting = false;

    function setBoost(active) {
        if (active === isBoosting) return;
        isBoosting = active;
        socket.volatile.emit('boost', active);
        if (active) audio.playBoostStart();
    }

    window.addEventListener('keydown', (e) => {
        if (e.code === 'Space' && !e.repeat) {
            e.preventDefault();
            setBoost(true);
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space') {
            setBoost(false);
        }
    });

    window.addEventListener('mousedown', (e) => {
        if (e.button === 2) { e.preventDefault(); setBoost(true); }
    });

    window.addEventListener('mouseup', (e) => {
        if (e.button === 2) setBoost(false);
    });

    window.addEventListener('contextmenu', (e) => e.preventDefault());

    // ── Boost Bar Update ────────────────────────────────────

    const boostFill = document.getElementById('boost-bar-fill');

    function updateBoostBar(fuel, boosting) {
        boostFill.style.width = (fuel * 100) + '%';
        boostFill.classList.toggle('draining', boosting && fuel > 0);
        boostFill.classList.toggle('empty', fuel <= 0.01);
    }

    // ── HUD Update ──────────────────────────────────────────

    function updateHUD(state) {
        if (!state) return;

        document.getElementById('player-count').textContent = 'Players: ' + state.players.length;
        document.getElementById('bot-count').textContent = 'Bots: ' + state.boids.length;

        const me = state.players.find(p => p.id === myPlayerId);
        if (me) {
            document.getElementById('stat-score').textContent = me.score;

            setStat('speed', me.speed);
            setStat('cohesion', me.cohesion);
            setStat('aggression', me.aggression);
            setStat('range', me.collectRange);

            prevMutations = {
                speed: me.speed, cohesion: me.cohesion,
                aggression: me.aggression, collectRange: me.collectRange
            };

            // Boost bar
            updateBoostBar(me.boostFuel, me.boosting);

            // Auto-release boost if fuel ran out
            if (isBoosting && me.boostFuel <= 0.01) {
                setBoost(false);
            }

            // Effect indicators
            updateEffectIndicators(me);

            if (!me.alive) {
                const ds = document.getElementById('death-screen');
                ds.classList.remove('hidden');
                void ds.offsetWidth;
                ds.classList.add('visible');
                audio.playDeath();
            }
        }
    }

    function setStat(name, value) {
        const el = document.getElementById('stat-' + name);
        const prev = parseFloat(el.textContent);
        el.textContent = value.toFixed(2);
        if (Math.abs(value - prev) > 0.005) {
            const stat = el.closest('.stat');
            stat.classList.add('flash');
            setTimeout(() => stat.classList.remove('flash'), 400);
        }
    }

    // ── Effect Indicators ─────────────────────────────────────

    function updateEffectIndicators(me) {
        const container = document.getElementById('effect-indicators');
        if (!container) return;
        let html = '';
        if (me.shieldTicks > 0) {
            html += '<div class="effect-pill effect-shield">SHIELD ' + Math.ceil(me.shieldTicks / 20) + 's</div>';
        }
        if (me.speedBurstTicks > 0) {
            html += '<div class="effect-pill effect-speed">SPEED ' + Math.ceil(me.speedBurstTicks / 20) + 's</div>';
        }
        if (me.slowTicks > 0) {
            html += '<div class="effect-pill effect-slow">SLOW ' + Math.ceil(me.slowTicks / 20) + 's</div>';
        }
        container.innerHTML = html;
    }

    // ── Leaderboard ─────────────────────────────────────────

    function updateLeaderboard(state) {
        if (!state) return;

        // Build entries: player id, score, boid count
        const entries = state.players.map(p => {
            const boidCount = state.boids.filter(b => b.playerId === p.id).length;
            return { id: p.id, score: p.score, boids: boidCount, alive: p.alive };
        });

        entries.sort((a, b) => b.score - a.score);
        const top5 = entries.slice(0, 5);

        const container = document.getElementById('lb-entries');
        container.innerHTML = '';

        for (let i = 0; i < top5.length; i++) {
            const e = top5[i];
            const color = hexToCSS(getPlayerColor(e.id));
            const isMe = e.id === myPlayerId;
            const div = document.createElement('div');
            div.className = 'lb-entry' + (isMe ? ' me' : '');
            div.innerHTML =
                '<span class="lb-rank">' + (i + 1) + '</span>' +
                '<span class="lb-color" style="background:' + color + '"></span>' +
                '<span class="lb-info">' +
                    '<span class="lb-name">' + (isMe ? 'YOU' : 'Swarm ' + e.id) + '</span>' +
                    '<span class="lb-score">' + e.score + ' / ' + e.boids + '</span>' +
                '</span>';
            container.appendChild(div);
        }
    }

    // ── Minimap ─────────────────────────────────────────────

    const minimapCanvas = document.getElementById('minimap');
    const mmCtx = minimapCanvas.getContext('2d');
    const MM_W = 160;
    const MM_H = 160;

    function drawMinimap() {
        mmCtx.clearRect(0, 0, MM_W, MM_H);

        if (!currState) return;

        const sx = MM_W / mapWidth;
        const sy = MM_H / mapHeight;

        // Resources (tiny dots)
        for (const r of currState.resources) {
            const color = hexToCSS(RESOURCE_COLORS[r.type] || 0x666666);
            mmCtx.fillStyle = color;
            mmCtx.globalAlpha = 0.3;
            mmCtx.fillRect(r.x * sx, r.y * sy, 1, 1);
        }

        // Pickups (slightly larger dots)
        const mmPickups = currState.pickups || [];
        for (const p of mmPickups) {
            const isGood = PICKUP_GOOD[p.type];
            mmCtx.fillStyle = isGood ? '#00ff88' : '#ff3333';
            mmCtx.globalAlpha = 0.7;
            mmCtx.fillRect(p.x * sx - 1, p.y * sy - 1, 3, 3);
        }

        // Boids (grouped by player)
        const byPlayer = {};
        for (const b of currState.boids) {
            if (!byPlayer[b.playerId]) byPlayer[b.playerId] = [];
            byPlayer[b.playerId].push(b);
        }

        for (const pid in byPlayer) {
            const color = hexToCSS(getPlayerColor(parseInt(pid)));
            const isMe = parseInt(pid) === myPlayerId;
            mmCtx.fillStyle = color;
            mmCtx.globalAlpha = isMe ? 0.9 : 0.5;
            for (const b of byPlayer[pid]) {
                const size = isMe ? 2 : 1;
                mmCtx.fillRect(b.x * sx - size / 2, b.y * sy - size / 2, size, size);
            }
        }

        // Viewport rectangle
        mmCtx.globalAlpha = 0.5;
        mmCtx.strokeStyle = '#ffffff';
        mmCtx.lineWidth = 1;
        mmCtx.strokeRect(
            cameraX * sx, cameraY * sy,
            window.innerWidth * sx, window.innerHeight * sy
        );
        mmCtx.globalAlpha = 1;
    }

    // ── Respawn ─────────────────────────────────────────────

    document.getElementById('respawn-btn').addEventListener('click', () => {
        const ds = document.getElementById('death-screen');
        ds.classList.remove('visible');
        ds.classList.add('hidden');
        socket.disconnect();
        socket.connect();
    });

    // ── Audio System (Web Audio API — procedural, upgraded) ──

    const audio = (() => {
        let ctx = null;
        let masterGain = null;
        let musicGain = null;
        let muted = false;
        let musicStarted = false;
        let boostOsc = null;
        let boostGain = null;

        function ensureCtx() {
            if (ctx) return true;
            try {
                ctx = new (window.AudioContext || window.webkitAudioContext)();
                masterGain = ctx.createGain();
                masterGain.gain.value = 0.4;
                masterGain.connect(ctx.destination);
                musicGain = ctx.createGain();
                musicGain.gain.value = 0.5;
                musicGain.connect(masterGain);
                return true;
            } catch (e) {
                return false;
            }
        }

        // ── MUSIC: Multi-layer ambient with chord changes ───

        function startMusic() {
            if (musicStarted || !ensureCtx()) return;
            musicStarted = true;

            // Layer 1: Warm stereo pad (4 detuned oscillators)
            const padGain = ctx.createGain();
            padGain.gain.value = 0.04;
            padGain.connect(musicGain);

            const padFilter = ctx.createBiquadFilter();
            padFilter.type = 'lowpass';
            padFilter.frequency.value = 350;
            padFilter.Q.value = 0.7;
            padFilter.connect(padGain);

            const padFreqs = [55, 55.2, 82.4, 82.7]; // A1 + E2 detuned
            for (const freq of padFreqs) {
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.value = freq;
                osc.connect(padFilter);
                osc.start();
            }

            // Layer 2: Deep sub pulse
            const subGain = ctx.createGain();
            subGain.gain.value = 0.07;
            subGain.connect(musicGain);

            const subOsc = ctx.createOscillator();
            subOsc.type = 'sine';
            subOsc.frequency.value = 36.7; // D1
            subOsc.connect(subGain);
            subOsc.start();

            // Slow LFO on pad filter for movement
            const lfo = ctx.createOscillator();
            lfo.type = 'sine';
            lfo.frequency.value = 0.08; // very slow
            const lfoGain = ctx.createGain();
            lfoGain.gain.value = 120;
            lfo.connect(lfoGain);
            lfoGain.connect(padFilter.frequency);
            lfo.start();

            // Layer 3: Chord progression arpeggiator
            // Am - F - C - G progression in pentatonic-friendly notes
            const chords = [
                [220, 261.63, 329.63],    // Am (A4 C5 E5)
                [174.61, 220, 261.63],     // F  (F4 A4 C5)
                [261.63, 329.63, 392],     // C  (C5 E5 G5)
                [196, 246.94, 329.63]      // G  (G4 B4 E5)
            ];
            let chordIdx = 0;
            let noteInChord = 0;

            function playArpNote() {
                if (!ctx) return;
                if (muted) { setTimeout(playArpNote, 800); return; }

                const chord = chords[chordIdx % chords.length];
                const freq = chord[noteInChord % chord.length];

                // Main note
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.025, ctx.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.0);
                g.connect(musicGain);

                const filt = ctx.createBiquadFilter();
                filt.type = 'lowpass';
                filt.frequency.setValueAtTime(1200, ctx.currentTime);
                filt.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 2.0);
                filt.connect(g);

                const osc = ctx.createOscillator();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                osc.connect(filt);
                osc.start();
                osc.stop(ctx.currentTime + 2.2);

                // Octave shimmer (quiet high layer)
                const g2 = ctx.createGain();
                g2.gain.setValueAtTime(0.008, ctx.currentTime);
                g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.5);
                g2.connect(musicGain);

                const osc2 = ctx.createOscillator();
                osc2.type = 'sine';
                osc2.frequency.value = freq * 2;
                osc2.connect(g2);
                osc2.start();
                osc2.stop(ctx.currentTime + 1.6);

                noteInChord++;
                if (noteInChord >= chord.length) {
                    noteInChord = 0;
                    chordIdx++;
                }

                const delay = 600 + Math.random() * 400;
                setTimeout(playArpNote, delay);
            }

            // Layer 4: Atmospheric texture (filtered noise pad)
            const noiseLen = ctx.sampleRate * 4;
            const noiseBuf = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
            const noiseData = noiseBuf.getChannelData(0);
            for (let i = 0; i < noiseLen; i++) {
                noiseData[i] = (Math.random() * 2 - 1) * 0.5;
            }

            const noiseNode = ctx.createBufferSource();
            noiseNode.buffer = noiseBuf;
            noiseNode.loop = true;

            const noiseFilt = ctx.createBiquadFilter();
            noiseFilt.type = 'bandpass';
            noiseFilt.frequency.value = 600;
            noiseFilt.Q.value = 0.3;

            const noiseGain = ctx.createGain();
            noiseGain.gain.value = 0.012;

            noiseNode.connect(noiseFilt);
            noiseFilt.connect(noiseGain);
            noiseGain.connect(musicGain);
            noiseNode.start();

            // Layer 5: Slow bell-like tones (every ~6s)
            function playBell() {
                if (!ctx) return;
                if (muted) { setTimeout(playBell, 6000); return; }

                const bellFreqs = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
                const freq = bellFreqs[Math.floor(Math.random() * bellFreqs.length)];

                const g = ctx.createGain();
                g.gain.setValueAtTime(0.015, ctx.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 4);
                g.connect(musicGain);

                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.value = freq;
                osc.connect(g);
                osc.start();
                osc.stop(ctx.currentTime + 4.2);

                setTimeout(playBell, 5000 + Math.random() * 4000);
            }

            setTimeout(playArpNote, 500);
            setTimeout(playBell, 3000);
        }

        // ── SFX ─────────────────────────────────────────────

        function playCollect(type) {
            if (!ensureCtx() || muted) return;
            const freqs = [880, 660, 330, 550];
            const freq = freqs[type] || 660;

            const g = ctx.createGain();
            g.gain.setValueAtTime(0.08, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
            g.connect(masterGain);

            const filt = ctx.createBiquadFilter();
            filt.type = 'bandpass';
            filt.frequency.value = freq;
            filt.Q.value = 3;
            filt.connect(g);

            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(freq * 1.6, ctx.currentTime + 0.12);
            osc.connect(filt);
            osc.start();
            osc.stop(ctx.currentTime + 0.18);

            // Harmonic ping
            const g2 = ctx.createGain();
            g2.gain.setValueAtTime(0.03, ctx.currentTime + 0.04);
            g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
            g2.connect(masterGain);

            const osc2 = ctx.createOscillator();
            osc2.type = 'sine';
            osc2.frequency.value = freq * 2;
            osc2.connect(g2);
            osc2.start(ctx.currentTime + 0.04);
            osc2.stop(ctx.currentTime + 0.2);
        }

        function playCombat() {
            if (!ensureCtx() || muted) return;
            const bufferSize = ctx.sampleRate * 0.15;
            const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / bufferSize, 1.5);
            }

            const noise = ctx.createBufferSource();
            noise.buffer = buffer;

            const filt = ctx.createBiquadFilter();
            filt.type = 'bandpass';
            filt.frequency.value = 350;
            filt.Q.value = 1.5;

            const g = ctx.createGain();
            g.gain.setValueAtTime(0.25, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);

            noise.connect(filt);
            filt.connect(g);
            g.connect(masterGain);
            noise.start();

            // Impact thud
            const thud = ctx.createOscillator();
            thud.type = 'sine';
            thud.frequency.setValueAtTime(80, ctx.currentTime);
            thud.frequency.exponentialRampToValueAtTime(30, ctx.currentTime + 0.1);
            const thudG = ctx.createGain();
            thudG.gain.setValueAtTime(0.15, ctx.currentTime);
            thudG.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
            thud.connect(thudG);
            thudG.connect(masterGain);
            thud.start();
            thud.stop(ctx.currentTime + 0.12);
        }

        function playDeath() {
            if (!ensureCtx() || muted) return;
            // Multi-layered death sweep
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.15, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.0);
            g.connect(masterGain);

            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(500, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.9);
            osc.connect(g);
            osc.start();
            osc.stop(ctx.currentTime + 1.0);

            // Noise wash
            const nLen = ctx.sampleRate * 0.6;
            const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
            const nData = nBuf.getChannelData(0);
            for (let i = 0; i < nLen; i++) {
                nData[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / nLen, 2);
            }
            const nNode = ctx.createBufferSource();
            nNode.buffer = nBuf;
            const nGain = ctx.createGain();
            nGain.gain.value = 0.08;
            nNode.connect(nGain);
            nGain.connect(masterGain);
            nNode.start();
        }

        function playSpawn() {
            if (!ensureCtx() || muted) return;
            startMusic();

            // Two-tone ascend
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.07, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
            g.connect(masterGain);

            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(180, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(700, ctx.currentTime + 0.3);
            osc.connect(g);
            osc.start();
            osc.stop(ctx.currentTime + 0.6);

            // Second tone delayed
            const g2 = ctx.createGain();
            g2.gain.setValueAtTime(0.05, ctx.currentTime + 0.15);
            g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
            g2.connect(masterGain);

            const osc2 = ctx.createOscillator();
            osc2.type = 'triangle';
            osc2.frequency.setValueAtTime(350, ctx.currentTime + 0.15);
            osc2.frequency.exponentialRampToValueAtTime(1100, ctx.currentTime + 0.45);
            osc2.connect(g2);
            osc2.start(ctx.currentTime + 0.15);
            osc2.stop(ctx.currentTime + 0.5);
        }

        function playBoostStart() {
            if (!ensureCtx() || muted) return;
            // Whoosh + rising tone
            const g = ctx.createGain();
            g.gain.setValueAtTime(0.1, ctx.currentTime);
            g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
            g.connect(masterGain);

            const osc = ctx.createOscillator();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(120, ctx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.15);
            const filt = ctx.createBiquadFilter();
            filt.type = 'lowpass';
            filt.frequency.value = 600;
            osc.connect(filt);
            filt.connect(g);
            osc.start();
            osc.stop(ctx.currentTime + 0.3);

            // Noise whoosh
            const wLen = ctx.sampleRate * 0.2;
            const wBuf = ctx.createBuffer(1, wLen, ctx.sampleRate);
            const wData = wBuf.getChannelData(0);
            for (let i = 0; i < wLen; i++) {
                const env = Math.sin((i / wLen) * Math.PI);
                wData[i] = (Math.random() * 2 - 1) * env * 0.5;
            }
            const wNode = ctx.createBufferSource();
            wNode.buffer = wBuf;
            const wFilt = ctx.createBiquadFilter();
            wFilt.type = 'highpass';
            wFilt.frequency.value = 2000;
            const wGain = ctx.createGain();
            wGain.gain.value = 0.06;
            wNode.connect(wFilt);
            wFilt.connect(wGain);
            wGain.connect(masterGain);
            wNode.start();
        }

        function playPickup(isGood) {
            if (!ensureCtx() || muted) return;
            if (isGood) {
                // Bright ascending chime
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.1, ctx.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
                g.connect(masterGain);
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(600, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.2);
                osc.connect(g);
                osc.start();
                osc.stop(ctx.currentTime + 0.4);
                // Harmony
                const g2 = ctx.createGain();
                g2.gain.setValueAtTime(0.05, ctx.currentTime + 0.08);
                g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
                g2.connect(masterGain);
                const osc2 = ctx.createOscillator();
                osc2.type = 'sine';
                osc2.frequency.value = 900;
                osc2.connect(g2);
                osc2.start(ctx.currentTime + 0.08);
                osc2.stop(ctx.currentTime + 0.35);
            } else {
                // Dark descending buzz
                const g = ctx.createGain();
                g.gain.setValueAtTime(0.12, ctx.currentTime);
                g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
                g.connect(masterGain);
                const osc = ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(300, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.25);
                const filt = ctx.createBiquadFilter();
                filt.type = 'lowpass';
                filt.frequency.value = 500;
                osc.connect(filt);
                filt.connect(g);
                osc.start();
                osc.stop(ctx.currentTime + 0.3);
            }
        }

        function toggleMute() {
            muted = !muted;
            if (masterGain) {
                masterGain.gain.value = muted ? 0 : 0.4;
            }
            return muted;
        }

        return { playCollect, playCombat, playDeath, playSpawn, playBoostStart, playPickup, toggleMute, startMusic, ensureCtx };
    })();

    // Mute button
    document.getElementById('mute-btn').addEventListener('click', () => {
        const isMuted = audio.toggleMute();
        document.getElementById('mute-btn').classList.toggle('muted', isMuted);
    });

    // Start audio on first interaction
    document.addEventListener('click', () => {
        audio.ensureCtx();
        audio.startMusic();
    }, { once: true });

    // ── Main Render Loop ────────────────────────────────────

    pixiApp.ticker.add(() => {
        if (!currState) return;

        frameCount++;
        const tickMs = 1000 / tickRate;
        const elapsed = performance.now() - lastStateTime;
        interpFactor = Math.min(elapsed / tickMs, 1.0);

        // ── Camera ──────────────────────────────────────────
        const myBoids = currState.boids.filter(b => b.playerId === myPlayerId);
        if (myBoids.length > 0) {
            let cx = 0, cy = 0;
            for (const b of myBoids) { cx += b.x; cy += b.y; }
            cx /= myBoids.length;
            cy /= myBoids.length;

            cameraX += (cx - window.innerWidth / 2 - cameraX) * CAMERA_LERP;
            cameraY += (cy - window.innerHeight / 2 - cameraY) * CAMERA_LERP;
        }

        // Screen shake decay
        let shakeX = 0, shakeY = 0;
        if (shakeIntensity > 0.1) {
            shakeX = (Math.random() - 0.5) * shakeIntensity;
            shakeY = (Math.random() - 0.5) * shakeIntensity;
            shakeIntensity *= 0.88;
        } else {
            shakeIntensity = 0;
        }

        worldContainer.x = -cameraX + shakeX;
        worldContainer.y = -cameraY + shakeY;

        // Viewport bounds for culling
        const vpL = cameraX - 50;
        const vpR = cameraX + window.innerWidth + 50;
        const vpT = cameraY - 50;
        const vpB = cameraY + window.innerHeight + 50;

        // ── Boids ───────────────────────────────────────────
        const boids = currState.boids;
        ensureBoidSprites(boids.length);

        for (let i = 0; i < boidSprites.length; i++) {
            if (i >= boids.length) {
                boidSprites[i].visible = false;
                continue;
            }

            const boid = boids[i];
            let px = boid.x, py = boid.y;

            // Interpolation
            if (prevState && prevState.boids[i] &&
                prevState.boids[i].playerId === boid.playerId) {
                const prev = prevState.boids[i];
                px = prev.x + (boid.x - prev.x) * interpFactor;
                py = prev.y + (boid.y - prev.y) * interpFactor;
            }

            const sprite = boidSprites[i];
            sprite.x = px;
            sprite.y = py;

            // Frustum culling
            if (px < vpL || px > vpR || py < vpT || py > vpB) {
                sprite.visible = false;
                continue;
            }
            sprite.visible = true;

            const color = getPlayerColor(boid.playerId);
            sprite.texture = getBoidTexture(color);

            // Rotation from velocity
            if (Math.abs(boid.vx) > 0.01 || Math.abs(boid.vy) > 0.01) {
                sprite.rotation = Math.atan2(boid.vy, boid.vx);
            }

            const isMine = boid.playerId === myPlayerId;
            sprite.scale.set(isMine ? 1.3 : 1.0);
            sprite.alpha = isMine ? 1.0 : 0.8;

            // Trails (only for own boids, every 3rd frame, faster when boosting)
            if (isMine && frameCount % (isBoosting ? 1 : 3) === 0) {
                spawnTrail(px, py, color);
            }

            // Boost speed lines: spawn bright streaks behind boosting boids
            if (isMine && isBoosting && frameCount % 2 === 0) {
                const speed = Math.sqrt(boid.vx * boid.vx + boid.vy * boid.vy);
                if (speed > 0.1) {
                    const nx = -boid.vx / speed;
                    const ny = -boid.vy / speed;
                    spawnParticle(
                        px + nx * 6 + (Math.random() - 0.5) * 4,
                        py + ny * 6 + (Math.random() - 0.5) * 4,
                        nx * 2.5, ny * 2.5,
                        0xffffff, 8, 0.3
                    );
                }
            }
        }

        // ── Connection Lines (own boids only, viewport) ─────
        connectionGraphics.clear();
        if (myBoids.length > 1 && myBoids.length < 150) {
            const color = getPlayerColor(myPlayerId);
            connectionGraphics.lineStyle(1, color, 0.06);
            const visible = myBoids.filter(b => b.x > vpL && b.x < vpR && b.y > vpT && b.y < vpB);
            const maxConn = Math.min(visible.length, 80);
            for (let i = 0; i < maxConn; i++) {
                for (let j = i + 1; j < maxConn; j++) {
                    const dx = visible[i].x - visible[j].x;
                    const dy = visible[i].y - visible[j].y;
                    if (dx * dx + dy * dy < 40 * 40) {
                        connectionGraphics.moveTo(visible[i].x, visible[i].y);
                        connectionGraphics.lineTo(visible[j].x, visible[j].y);
                    }
                }
            }
        }

        // ── Resources ───────────────────────────────────────
        const resources = currState.resources;
        ensureResourceSprites(resources.length);
        const now = performance.now();

        for (let i = 0; i < resourceSprites.length; i++) {
            if (i >= resources.length) {
                resourceSprites[i].visible = false;
                continue;
            }

            const res = resources[i];
            const sprite = resourceSprites[i];

            if (res.x < vpL || res.x > vpR || res.y < vpT || res.y > vpB) {
                sprite.visible = false;
                continue;
            }

            sprite.x = res.x;
            sprite.y = res.y;
            sprite.visible = true;
            sprite.texture = resourceTextures[res.type] || resourceTextures[0];

            // Rotation + pulse
            sprite.rotation = now * 0.001 + i;
            const pulse = 0.85 + 0.15 * Math.sin(now * 0.004 + i * 2);
            sprite.scale.set(pulse);
        }

        // ── Pickups ─────────────────────────────────────────
        const pickups = currState.pickups || [];
        ensurePickupSprites(pickups.length);

        for (let i = 0; i < pickupSprites.length; i++) {
            if (i >= pickups.length) {
                pickupSprites[i].visible = false;
                continue;
            }

            const pk = pickups[i];
            const sprite = pickupSprites[i];

            if (pk.x < vpL || pk.x > vpR || pk.y < vpT || pk.y > vpB) {
                sprite.visible = false;
                continue;
            }

            sprite.x = pk.x;
            sprite.y = pk.y;
            sprite.visible = true;
            sprite.texture = pickupTextures[pk.type] || pickupTextures[0];

            // Hover animation (bob up/down) + slow spin
            const bob = Math.sin(now * 0.003 + i * 1.5) * 3;
            sprite.y = pk.y + bob;
            sprite.rotation = now * 0.0015 + i;

            // Pulsing scale
            const pulse = 1.0 + 0.2 * Math.sin(now * 0.005 + i * 2);
            sprite.scale.set(pulse);
        }

        // ── Update systems ──────────────────────────────────
        updateParticles();
        updateTrails();
        updateAmbientDust();

        // Minimap every 3 frames
        if (frameCount % 3 === 0) {
            drawMinimap();
        }
    });

    console.log('[SwarmMind.io] Client initialized (VFX + Audio Edition)');
})();
