//=============================================================================
// SAN_AnalogMove.js
//=============================================================================
// Copyright (c) 2015-2018 Sanshiro
// Released under the MIT license
// http://opensource.org/licenses/mit-license.php
//=============================================================================

/*:
 * @plugindesc アナログムーブ 3.1.5
 * パーティキャラクターの移動をドット移動に変更します。
 * @author サンシロ https://twitter.com/rev2nym
 * 
 * @help
 * ■概要
 * パーティキャラクターの移動をタイルによらないドット移動に変更します。
 * 方向キー操作、タッチ操作に対応します。
 * 
 * ■アナログスティック入力
 * アナログスティックによる任意方向への移動や速度調節に対応するためには
 * プラグイン「アナログスティック(SAN_AnalogStick.js)」を導入してください。
 * 
 * ■利用規約
 * MITライセンスのもと、商用利用、改変、再配布が可能です。
 * ただし冒頭のコメントは削除や改変をしないでください。
 * 
 * これを利用したことによるいかなる損害にも作者は責任を負いません。
 * サポートは期待しないでください＞＜。
 */

var Imported = Imported || {};
Imported.SAN_AnalogMove = true;

var Sanshiro = Sanshiro || {};
Sanshiro.AnalogMove = Sanshiro.AnalogMove || {};
Sanshiro.AnalogMove.version = '3.1.5';

(function() {
'use strict';

//-----------------------------------------------------------------------------
// Vector
//
// ベクトル

function Vector() {
    this.initialize.apply(this, arguments);
}

// 許容誤差定数
Vector.errMargin = Math.pow(0.5, 16);

// ラジアンディグリー変換
Vector.radToDeg = function(rad) {
    return (180 / Math.PI) * rad;
};

// ディグリーラジアン変換
Vector.degToRad = function(deg) {
    return (Math.PI / 180) * deg;
};

// ラジアン正規化
Vector.normRad = function(rad) {
    return Math.atan2(Math.sin(rad), Math.cos(rad));
};

// 直交座標によるベクトルの生成
Vector.rect = function(x, y) {
    var vec = new Vector();
    vec.setRect(x, y);
    return vec;
};

// 極座標によるベクトルの生成
Vector.polar = function(len, dir) {
    var vec = new Vector();
    vec.setPolar(len, dir);
    return vec;
};

// 全座標によるベクトルの生成
Vector.create = function(x, y, len, dir) {
    var vec = new Vector();
    vec._x = x;
    vec._y = y;
    vec._len = len;
    vec._dir = dir;
    return vec;
};

// オブジェクト初期化
Vector.prototype.initialize = function() {
    this._x = 0.0;
    this._y = 0.0;
    this._len = 0.0;
    this._dir = 0.0;
};

// 直交座標のリフレッシュ
Vector.prototype.refreshRect = function() {
    this._x = this._len * Math.cos(this._dir);
    this._y = this._len * Math.sin(this._dir);
    this.refreshPolar();
};

// 極座標のリフレッシュ
Vector.prototype.refreshPolar = function() {
    this._len = Math.sqrt(Math.pow(this._x, 2) + Math.pow(this._y, 2));
    if (this._len !== 0.0 || this._dir === undefined) {
        this._dir = Math.atan2(this._y, this._x);
    }
};

// X成分
Vector.prototype.x = function() {
    return this._x;
};

// Y成分
Vector.prototype.y = function() {
    return this._y;
};

// 長さ2乗
Vector.prototype.lenSq = function() {
    return Math.pow(this._len, 2);
};

// 長さ
Vector.prototype.len = function() {
    return this._len;
};

// 角度ラジアン
Vector.prototype.dir = function() {
    return this._dir;
};

// 直交座標の設定
Vector.prototype.setRect = function(x, y) {
    this._x = x;
    this._y = y;
    this.refreshPolar();
};

// X成分の設定
Vector.prototype.setX = function(x) {
    this._x = x;
    this.refreshPolar();
};

// Y成分の設定
Vector.prototype.setY = function(y) {
    this._y = y;
    this.refreshPolar();
};

// 極座標の設定
Vector.prototype.setPolar = function(len, dir) {
    this._len = len;
    this._dir = dir;
    this.refreshRect();
};

// 長さの設定
Vector.prototype.setLen = function(len) {
    this._len = len;
    this.refreshRect();
};

// 角度ラジアンの設定
Vector.prototype.setDir = function(dir) {
    this._dir = dir;
    this.refreshRect();
};

// 加算ベクトル
Vector.prototype.add = function(vec) {
    return Vector.rect(this.x() + vec.x(), this.y() + vec.y());
};

// 加算ベクトル(ループマップ考慮)
Vector.prototype.add2 = function(vec) {
    return Vector.rect(
        $gameMap.roundX(this.x() + vec.x()),
        $gameMap.roundY(this.y() + vec.y())
    );
};

// 減算ベクトル
Vector.prototype.sub = function(vec) {
    return Vector.rect(this.x() - vec.x(), this.y() - vec.y());
};

// 減算ベクトル(ループマップ考慮)
Vector.prototype.sub2 = function(vec) {
    return Vector.rect(
        $gameMap.deltaX(this.x(), vec.x()),
        $gameMap.deltaY(this.y(), vec.y())
    );
};

// 乗算ベクトル
Vector.prototype.mul = function(mul) {
    return Vector.rect(mul * this.x(), mul * this.y());
};

// 除算ベクトル
Vector.prototype.div = function(div) {
    return this.mul(1.0 / div);
};

// 正規化ベクトル
Vector.prototype.norm = function() {
    return (this.len() === 0.0 ?
        Vector.polar(1.0, this.dir()) :
        this.mul(1.0 / this.len())
    );
};

// 長さ指定ベクトル
Vector.prototype.scl = function(scl) {
    return (this.len() === 0.0 ?
        Vector.polar(scl, this.dir()) :
        this.mul(scl / this.len())
    );
};

// 逆ベクトル
Vector.prototype.inv = function() {
    return (this.len() === 0.0 ?
        Vector.polar(0.0, this.dir() + Math.PI) :
        Vector.rect(-this.x(), -this.y())
    );
};

// 法線ベクトル
Vector.prototype.perp = function() {
    return (this.len() === 0.0 ? 
        Vector.polar(0.0, this.dir() + Math.PI / 2.0) :
        Vector.rect(-this.y(), this.x())
    );
};

// 回転ベクトル
Vector.prototype.rot = function(rot) {
    return Vector.polar(this.len(), this.dir() + rot);
};

// 複製ベクトル
Vector.prototype.clone = function() {
    return Vector.create(this.x(), this.y(), this.len(), this.dir());
};

// 内積
Vector.prototype.dot = function(vec) {
    return this.x() * vec.x() + this.y() * vec.y();
};

// 外積
Vector.prototype.cross = function(vec) {
    return this.x() * vec.y() - this.y() * vec.x();
};

// cos
Vector.prototype.cos = function(vec) {
    return this.norm().dot(vec.norm());
};

// sin
Vector.prototype.sin = function(vec) {
    return this.norm().cross(vec.norm());
};

// tan
Vector.prototype.tan = function(vec) {
    return this.sin(vec) / this.cos(vec);
};

// 垂直判定
Vector.prototype.isVert = function(vec) {
    return Math.abs(this.cos(vec)) <= Vector.errMargin;
};

// 平行判定
Vector.prototype.isPara = function(vec) {
    return Math.abs(this.sin(vec)) <= Vector.errMargin;
};

// 鋭角判定
Vector.prototype.isSharp = function(vec) {
    return this.dot(vec) > 0.0;
};

// 等価判定
Vector.prototype.equals = function(vec) {
    return (
        this.len() === vec.len() &&
        this.dir() === vec.dir()
    );
};

// デバッグ用表示
Vector.prototype.disp = function() {
    console.log("x : " + this.x());
    console.log("y : " + this.y());
    console.log("len : " + this.len());
    console.log("dir : " + this.dir());
};

//-----------------------------------------------------------------------------
// CharacterMover
//
// キャラクタームーバー

function CharacterMover() {
    this.initialize.apply(this, arguments);
}

// ラジアン方向を8方向に変換
CharacterMover.radToDir8 = function(radian) {
    var piDiv8 = Math.PI / 8.0;
    return (
        radian < piDiv8 * -7.0 ? 4 :
        radian < piDiv8 * -5.0 ? 7 :
        radian < piDiv8 * -3.0 ? 8 :
        radian < piDiv8 * -1.0 ? 9 :
        radian < piDiv8 *  1.0 ? 6 :
        radian < piDiv8 *  3.0 ? 3 :
        radian < piDiv8 *  5.0 ? 2 :
        radian < piDiv8 *  7.0 ? 1 :
        4
    );
};

// 8方向をラジアン方向に変換
CharacterMover.dir8ToRad = function(dir8) {
    var x = (dir8 % 3 === 0 ? 1.0 : (dir8 % 3 === 1 ? -1.0 : 0.0));
    var y = (dir8 / 3 <=  1 ? 1.0 : (dir8 / 3 >   2 ? -1.0 : 0.0));
    return Math.atan2(y, x);
};

// ラジアン方向を4方向に変換
CharacterMover.radToDir4 = function(radian) {
    var piDiv4 = Math.PI / 4.0;
    return (
        radian < piDiv4 * -3.0 ? 4 :
        radian < piDiv4 * -1.0 ? 8 :
        radian < piDiv4 *  1.0 ? 6 :
        radian < piDiv4 *  3.0 ? 2 :
        4
    );
};

// 4方向をラジアン方向に変換
CharacterMover.dir4ToRad = function(dir4) {
    return this.dir8ToRad(dir4);
};

// 8方向を4方向に変換
CharacterMover.dir8ToDir4 = function(dir8, dir4) {
    return (
        dir8 % 2 === 0 ? dir8 :
        dir8 === 7 ? (dir4 === 6 ? 8 : 4) :
        dir8 === 9 ? (dir4 === 2 ? 6 : 8) :
        dir8 === 3 ? (dir4 === 4 ? 2 : 6) :
        dir8 === 1 ? (dir4 === 8 ? 4 : 2) :
        2
    );
};

// オブジェクト初期化
CharacterMover.prototype.initialize = function(character) {
    this.initVectors(character);
    this.initflags();
};

// 各ベクトルの初期化
CharacterMover.prototype.initVectors = function(character) {
    this._posVec = character.posVec(); // 位置ベクトル
    this._velVec = character.dirVec(); // 速度ベクトル
    this._tarPosVec = null; // 目標位置ベクトル
    this._tarDirVec = character.dirVec(); // 目標進行方位
    this._lasPosVec = character.posVec(); // 前回位置ベクトル
};

// 各フラグの初期化
CharacterMover.prototype.initflags = function() {
    this._through = false;
};

// 位置ベクトル
CharacterMover.prototype.posVec = function() {
    return this._posVec;
};

// 位置ベクトルの設定
CharacterMover.prototype.setPosVec = function(posVec) {
    return this._posVec = posVec;
};

// 速度ベクトル
CharacterMover.prototype.velVec = function() {
    return this._velVec;
};

// 速度ベクトルの設定
CharacterMover.prototype.setVelVec = function(velVec) {
    return this._velVec = velVec;
};

// キャラクター
CharacterMover.prototype.character = function() {
    return $gamePlayer;
};

// フレーム間移動距離
CharacterMover.prototype.dpf = function() {
    return this.character().distancePerFrame();
};

// すり抜け判定
CharacterMover.prototype.isThrough = function() {
    return this._through;
};

// ダッシュ判定
CharacterMover.prototype.isDashing = function() {
    return this.character().isDashing();
};

// 移動後位置ベクトル
CharacterMover.prototype.movPosVec = function() {
    return this._posVec.add2(this._velVec);
};

// 正面位置ベクトル
CharacterMover.prototype.froPosVec = function() {
    return this._posVec.add2(Vector.polar(1.0, this._velVec.dir()));
};

// フレーム更新
CharacterMover.prototype.update = function() {
    this.updateLastPosition();
    this.updateTargetPosition();
    this.updateVelocity();
    this.updatePosition();
    this.updateThrough();
    this.updateCharacter();
};

// 前回位置の更新
CharacterMover.prototype.updateLastPosition = function() {
    this._posVec = this.character().posVec();
    this._lasPosVec = this._posVec.clone();
};

// 目標方向の更新
CharacterMover.prototype.updateTargetPosition = function() {
    this._tarPosVec = null;
};

// 方向の更新
CharacterMover.prototype.updateVelocity = function() {
    var velVecLen = 0.0;
    var velVecDir = this._velVec.dir();
    if (!!this._tarPosVec) {
        var relPosVec = this._tarPosVec.sub2(this._posVec);
        velVecLen = Math.min(this.dpf(), relPosVec.len());
        velVecDir = relPosVec.dir();
    }
    this._velVec = Vector.polar(velVecLen, velVecDir);
};

// 位置の更新
CharacterMover.prototype.updatePosition = function() {
    var orgVelVec = this._velVec.clone();
    var splVelVecs = this.splitedVelocityVectors();
    splVelVecs.forEach(
        function(splVelVec) {
            this._velVec = splVelVec;
            this.checkColliding();
            this._posVec = this.movPosVec();
        }, this
    );
    this._velVec = orgVelVec;
};

// 分割速度ベクトル
CharacterMover.prototype.splitedVelocityVectors = function() {
    var velVec = this._velVec.clone();
    var velVecDir = this._velVec.dir();
    var splLen = 1.0 / 16.0;
    var splVelVecs = [];
    while (velVec.len() > 0.0) {
        var splVelVeclen = Math.min(velVec.len(), splLen);
        var splVelVec = Vector.polar(splVelVeclen, velVecDir);
        splVelVecs.push(splVelVec);
        velVec.setLen(Math.max(0.0, velVec.len() - splVelVeclen));
    }
    return splVelVecs;
};

// 衝突確認
CharacterMover.prototype.checkColliding = function() {
    this.checkCollidingTile();
    this.checkCollidingCharacter();
    this.checkCollidingTile();
};

// 衝突キャラクター
CharacterMover.prototype.collidingCharacters = function() {
    var characters = [];
    if (!this.isThrough()) {
        characters = $gameMap.allCharacters().filter(
            function(character) {
                return this.isCollidingCharacter(character);
            }, this
        );
    }
    return characters;
};

// 衝突キャラクター
CharacterMover.prototype.isCollidingCharacter = function(character) {
    return (
        !this.isThrough() &&
        !character.isThrough() &&
        this.isCollidingDistanceCharacter(character) &&
        character !== this.character()
    );
};

// 衝突マージン距離
CharacterMover.prototype.collideMargin = function() {
    return this._velVec.len() / 2.0;
};

// 衝突距離キャラクター判定
CharacterMover.prototype.isCollidingDistanceCharacter = function(character) {
    var chaPosVec = character.posVec();
    var relPosVec1 = chaPosVec.sub2(this._posVec);
    var relPosVec2 = chaPosVec.sub2(this.movPosVec());
    return (
        relPosVec1.cos(this._velVec) > Math.cos(Math.PI * 3.0 / 4.0) &&
        relPosVec2.len() < 1.0 - this.collideMargin()
    );
};

// タイルとの衝突確認
CharacterMover.prototype.checkCollidingTile = function() {
    if (this.isThrough() || this._velVec.len() === 0.0) {
        return;
    }
    this.checkCollidingCorners();
    this.checkCollidingHorzEdges();
    this.checkCollidingVertEdges();
};

// 各コーナーとの衝突確認
CharacterMover.prototype.checkCollidingCorners = function() {
    var cornerDirections = [3, 1, 7, 9];
    cornerDirections.forEach(
        function(d) {
            this.checkCollidingCorner(d);
        }, this
    );
};

// コーナーとの衝突確認
CharacterMover.prototype.checkCollidingCorner = function(d) {
    var x = Math.floor(this.movPosVec().x());
    var y = Math.floor(this.movPosVec().y());
    var offsetVec = this.offsetVecWithDir8(d);
    var movPosVec2 = this.movPosVec().add2(offsetVec);
    var x2 = Math.floor(movPosVec2.x());
    var y2 = Math.floor(movPosVec2.y());
    if (x !== x2 && y !== y2) {
        var corPosVec = this.character().cornerPos(x, y, d);
        if (!corPosVec) {
            return;
        }
        var relPosVec = corPosVec.sub2(this.movPosVec());
        if (relPosVec.len() < 0.5 - this.collideMargin()) {
            this._velVec = this.evadingVelVec(corPosVec);
            if (this.collidingCharacters().length !== 0) {
                this._velVec = Vector.polar(0.0, 0.0);
            }
        }
    }
};

// 8方向によるオフセットベクトル
CharacterMover.prototype.offsetVecWithDir8 = function(dir8) {
    var dir = CharacterMover.dir8ToRad(dir8);
    var len = 0.75;
    var offsetVec = Vector.polar(len, dir);
    return offsetVec;
};

// 各水平エッジとの衝突確認
CharacterMover.prototype.checkCollidingHorzEdges = function() {
    if (this._velVec.x() === 0.0) {
        return;
    }
    var d = (this._velVec.x() < 0.0 ? 4 : 6);
    var x = Math.floor(this.movPosVec().x());
    var y = Math.floor(this.movPosVec().y());
    var edgPosVec = this.character().edgePos(x, y, d);
    if (!edgPosVec) {
        return;
    }
    if (Math.abs(edgPosVec.x() - this.movPosVec().x()) < 0.5) {
        this._velVec.setX(0.0);
        this._posVec.setX(Math.floor(this._posVec.x()) + 0.5);
    }
};

// 各垂直エッジとの衝突確認
CharacterMover.prototype.checkCollidingVertEdges = function() {
    if (this._velVec.y() === 0.0) {
        return;
    }
    var d = (this._velVec.y() < 0.0 ? 8 : 2);
    var x = Math.floor(this.movPosVec().x());
    var y = Math.floor(this.movPosVec().y());
    var edgPosVec = this.character().edgePos(x, y, d);
    if (!edgPosVec) {
        return;
    }
    if (Math.abs(edgPosVec.y() - this.movPosVec().y()) < 0.5) {
        this._velVec.setY(0.0);
        this._posVec.setY(Math.floor(this._posVec.y()) + 0.5);
    }
};

// キャラクターとの衝突確認
CharacterMover.prototype.checkCollidingCharacter = function() {
    if (this.isThrough() || this._velVec.len() === 0.0) {
        return;
    }
    var collidingCharacters = this.collidingCharacters();
    if (collidingCharacters.length > 1) {
        this._velVec = Vector.polar(0.0, 0.0);        
    } else if (collidingCharacters.length > 0) {
        var character = collidingCharacters[0];
        this._velVec = this.evadingVelVec(character.posVec());
    }
};

// 指定位置ベクトルを避ける速度ベクトル
CharacterMover.prototype.evadingVelVec = function(posVec) {
    var relPosVec = posVec.sub2(this._posVec);
    var evaVelVecLen = relPosVec.norm().cross(this._velVec);
    var evaVelVec = relPosVec.perp().scl(evaVelVecLen);
    return evaVelVec;
};

// すり抜けの更新
CharacterMover.prototype.updateThrough = function() {
    this._through = this.character().isThrough();
};

// キャラクターの更新
CharacterMover.prototype.updateCharacter = function() {
    this.character().setPosVec(this._posVec);
    this.character().setDirVec(this._velVec);
};

// 移動中判定
CharacterMover.prototype.isMoving = function() {
    return this._lasPosVec.sub2(this._posVec).len() > 1.0 / 256.0;
};

// フレーム間移動距離
CharacterMover.prototype.distanceMoved = function() {
    return this._lasPosVec.sub2(this._posVec).len();
};

// 衝突し得るイベント
CharacterMover.prototype.isCollidableEvent = function(character) {
    return false;
};

// 衝突し得る乗り物
CharacterMover.prototype.isCollidableVehicle = function(character) {
    return false;
};

//-----------------------------------------------------------------------------
// PlayerMover
//
// プレイヤームーバー

function PlayerMover() {
    this.initialize.apply(this, arguments);
}

PlayerMover.prototype = Object.create(CharacterMover.prototype);
PlayerMover.prototype.constructor = PlayerMover;

// オブジェクト初期化
PlayerMover.prototype.initialize = function(character) {
    CharacterMover.prototype.initialize.call(this, character);
    this._collidingEventIds = []; // 接触イベントIDリスト
    this._encounterCount = 0.0; // エンカウント歩数
};

// キャラクター
PlayerMover.prototype.character = function() {
    return $gamePlayer;
};

// 接触イベントIDリスト
PlayerMover.prototype.collidingEventIds = function() {
    return this._collidingEventIds;
};

// フレーム更新
PlayerMover.prototype.update = function() {
    this.updateCollidingEventIds();
    CharacterMover.prototype.update.call(this);
};

// 接触イベントIDリストの更新
PlayerMover.prototype.updateCollidingEventIds = function() {
    this._collidingEventIds = [];
};

// 目標位置の更新
PlayerMover.prototype.updateTargetPosition = function() {
    if ($gameTemp.isDestinationValid()) {
        this._tarPosVec = Vector.rect(
            $gameTemp.destinationX() + 0.5,
            $gameTemp.destinationY() + 0.5
        );
        if (this._tarPosVec.sub2(this._posVec).len() < 1.0 / 96.0) {
            this.clearTargetPosition();
        }
    }
};

// 目標位置のクリア
PlayerMover.prototype.clearTargetPosition = function() {
    this._tarPosVec = null;
};

// 速度の更新
PlayerMover.prototype.updateVelocity = function() {
    if (this.isInputed()) {
        $gameTemp.clearDestination();
        this.clearTargetPosition();
        this.updateVelocityByInput();
    } else {
        CharacterMover.prototype.updateVelocity.call(this);
    }
};

// 速度の更新
PlayerMover.prototype.updateVelocityByInput = function() {
    var velVecLen = 0.0;
    var velVecDir = 0.0;
    if (!!this.analogStick() && !!this.analogStick().tilt) {
        velVecLen = this.analogStick().tilt * this.dpf();
        velVecDir = this.analogStick().dir;
    } else if (Input.dir8 !== 0) {
        velVecLen = this.dpf();
        velVecDir = CharacterMover.dir8ToRad(Input.dir8);
    }
    this._velVec = Vector.polar(velVecLen, velVecDir);
};

// 入力有無判定
PlayerMover.prototype.isInputed = function() {
    return (
        (!!this.analogStick() && this.analogStick().tilt !== 0.0) ||
        Input.dir8 !== 0
    );
};

// アナログスティック入力値
PlayerMover.prototype.analogStick = function() {
    if (Imported.SAN_AnalogStick) {
        return Input.leftStick;
    }
    return undefined;
};

// 衝突キャラクター
PlayerMover.prototype.collidingCharacters = function() {
    var characters = CharacterMover.prototype.collidingCharacters.call(this);
    var events = characters.filter(
        function(character) {
            return character instanceof Game_Event;
        }
    );
    var eventIds = events.map(
        function(event) {
            return event.eventId();
        }
    );
    this._collidingEventIds = this._collidingEventIds.concat(eventIds);
    this._collidingEventIds = this._collidingEventIds.filter(
        function(eventId, index, eventIds) {
            return eventIds.indexOf(eventId) === index;
        }
    );
    return characters;
};

// 衝突キャラクター
PlayerMover.prototype.isCollidingCharacter = function(character) {
    return (
        !this.isThrough() &&
        !character.isThrough() &&
        character !== this.character() &&
        this.isCollidableCharacter(character) &&
        this.isCollidingDistanceCharacter(character)
    );
};

// 衝突し得るキャラクター
PlayerMover.prototype.isCollidableCharacter = function(character) {
    return (
        this.isCollidableEvent(character) ||
        this.isCollidableVehicle(character)
    );
};

// 衝突し得るイベント
PlayerMover.prototype.isCollidableEvent = function(character) {
    return (
        character instanceof Game_Event &&
        character.isNormalPriority()
    );
};

// 衝突し得る乗り物
PlayerMover.prototype.isCollidableVehicle = function(character) {
    return (
        character instanceof Game_Vehicle &&
        (
            (this.character().isInBoat() && character.isShip()) ||
            (this.character().isInShip() && character.isBoat())
        )
    );
};

//-----------------------------------------------------------------------------
// FollowerMover
//
// フォロワームーバー

function FollowerMover() {
    this.initialize.apply(this, arguments);
}

FollowerMover.prototype = Object.create(CharacterMover.prototype);
FollowerMover.prototype.constructor = FollowerMover;

// オブジェクト初期化
FollowerMover.prototype.initialize = function(character) {
    this._followerIndex = character.followerIndex();
    CharacterMover.prototype.initialize.call(this, character);
};

// キャラクター
FollowerMover.prototype.character = function() {
    return $gamePlayer.followers().follower(this._followerIndex);
};

// フレーム間移動距離
FollowerMover.prototype.dpf = function() {
    var dpfCoef = (
        $gamePlayer.areFollowersGathering() ? 1.0 :
        !this._tarPosVec ? 1.0 :
        Math.pow(this._tarPosVec.sub2(this._posVec).len() * 2.0, 2)
    );
    dpfCoef = Math.max(1.0 / 4.0, Math.min(dpfCoef, 2.0));
    return CharacterMover.prototype.dpf.call(this) * dpfCoef;
};

// すり抜けの更新
FollowerMover.prototype.updateThrough = function() {
    if ($gamePlayer.isThrough()) {
        this._through = true;
    } else if (!this._tarPosVec) {
        this._through = false;
    } else if (this._through) {
        this._through = this._tarPosVec.sub2(this._posVec).len() > 0.125;
    } else {
        this._through = this._tarPosVec.sub2(this._posVec).len() > 2.000;
    }
};

// 目標位置の更新
FollowerMover.prototype.updateTargetPosition = function() {
    var precedingCharacter = this.character().precedingCharacter();
    var preChaPosVec = precedingCharacter.posVec();
    var relPosVec = preChaPosVec.sub2(this._posVec);
    this._tarPosVec = (
        $gamePlayer.areFollowersGathering() ? preChaPosVec :
        relPosVec.len() > 1.0 ? preChaPosVec.sub2(relPosVec.scl(1.0)) :
        null
    );
};

// 位置の更新
FollowerMover.prototype.updatePosition = function() {
    if (!this.character().isVisible()) {
        this._posVec = $gamePlayer.posVec();
        return;
    }
    CharacterMover.prototype.updatePosition.call(this);
};

// キャラクターの更新
FollowerMover.prototype.updateCharacter = function() {
    var precedingCharacter = this.character().precedingCharacter();
    var preChaPosVec = precedingCharacter.posVec();
    var relPosVec = preChaPosVec.sub2(this._posVec);
    this.character().setPosVec(this._posVec);
    this.character().setDirVec(relPosVec);
};

// 衝突キャラクター
FollowerMover.prototype.isCollidingCharacter = function(character) {
    return (
        !this.isThrough() &&
        !character.isThrough() &&
        character !== this.character() &&
        this.isCollidableCharacter(character) &&
        this.isCollidingDistanceCharacter(character)
    );
};

// 衝突し得るイベント
FollowerMover.prototype.isCollidableCharacter = function(character) {
    return PlayerMover.prototype.isCollidableEvent.call(this, character);
};

//-----------------------------------------------------------------------------
// Game_CharacterBase
//
// キャラクターベース

// ムーバーの初期化
Game_CharacterBase.prototype.initMover = function() {
    return;
};

// ムーバー
Game_CharacterBase.prototype.mover = function() {
    return undefined;
};

// ムーバー存在判定
Game_CharacterBase.prototype.hasMover = function() {
    return !!this._mover;
};

// ムーバーのリフレッシュ
Game_CharacterBase.prototype.refreshMover = function() {
    this._mover.setPosVec(this.posVec());
    this._mover.setVelVec(this.dirVec());
};

// 位置ベクトル
Game_CharacterBase.prototype.posVec = function() {
    return Vector.rect(this._realX + 0.5, this._realY + 0.5);
};

// 位置ベクトルの設定
Game_CharacterBase.prototype.setPosVec = function(posVec) {
    this._realX = posVec.x() - 0.5;
    this._realY = posVec.y() - 0.5;
    this._x = Math.round(this._realX);
    this._y = Math.round(this._realY);
};

// 方向ベクトル
Game_CharacterBase.prototype.dirVec = function() {
    return Vector.polar(0.0, CharacterMover.dir8ToRad(this.direction()));
};

// 方向ベクトルの設定
Game_CharacterBase.prototype.setDirVec = function(dirVec) {
    this.setDirection(CharacterMover.radToDir4(dirVec.dir()));
};

// フレーム更新
var _Game_CharacterBase_update =
    Game_CharacterBase.prototype.update;
Game_CharacterBase.prototype.update = function() {
    if (this.canAnalogMove()) {
        this.updateAnalogMove();
        return;
    }
    _Game_CharacterBase_update.call(this);
};

// アナログムーブ可能判定
Game_CharacterBase.prototype.canAnalogMove = function() {
    return false;
};

// アナログムーブ可能判定
Game_CharacterBase.prototype.updateAnalogMove = function() {
    this.updateMover();
    if (!this.isMoving()) {
        this.updateStop();
    } else {
        this.resetStopCount();
    }
    this.updateAnimation();
    this.updateBushDepth();
    this.updateDirectionByLadder();
};

// 茂み深さの更新
Game_CharacterBase.prototype.updateBushDepth = function() {
    this._bushDepth = this.needsBushDepth() ? 12 : 0;
};

// 茂み深さ必要判定
Game_CharacterBase.prototype.needsBushDepth = function() {
    return (
        this.isNormalPriority() &&
        !this.isObjectCharacter() &&
        this.isOnBush() &&
        !this.isJumping()
    );
};

// 梯子による向きの更新
Game_CharacterBase.prototype.updateDirectionByLadder = function() {
    if (this.isOnLadder()) {
        this.setDirection(8);
    }
};

// ムーバーの更新
Game_CharacterBase.prototype.updateMover = function() {
    this._mover.update();
};

// 座標の設定
var _Game_CharacterBase_setPosition =
    Game_CharacterBase.prototype.setPosition;
Game_CharacterBase.prototype.setPosition = function(x, y) {
    _Game_CharacterBase_setPosition.call(this, x, y);
    if (this.hasMover()) {
        this.refreshMover();
    }
};

// 座標のコピー
var _Game_CharacterBase_copyPosition =
    Game_CharacterBase.prototype.copyPosition;
Game_CharacterBase.prototype.copyPosition = function(character) {
    _Game_CharacterBase_copyPosition.call(this, character);
    if (this.hasMover()) {
        this.refreshMover();
    }
};

// 向きの設定
var _Game_CharacterBase_setDirection =
    Game_CharacterBase.prototype.setDirection;
Game_CharacterBase.prototype.setDirection = function(d) {
    _Game_CharacterBase_setDirection.call(this, d);
    if (this.hasMover()) {
        this.refreshMover();
    }
};

// エッジ判定
Game_CharacterBase.prototype.isEdge = function(x, y, d) {
    var x2 = $gameMap.roundXWithDirection(x, d);
    var y2 = $gameMap.roundYWithDirection(y, d);
    var d2 = this.reverseDir(d);
    if ($gameMap.isValid(x2, y2)) {
        if (!this.isThrough()) {
            return (
                !this.isMapPassable(x, y, d) ||
                !this.isMapPassable(x2, y2, d2)
            );
        }
        return false;
    }
    return true;
};

// エッジ位置ベクトル
Game_CharacterBase.prototype.edgePos = function(x, y, d) {
    if (this.isEdge(x, y, d)) {
        return (
            d === 6 ? Vector.rect(x + 1.0, y + 0.5) :
            d === 2 ? Vector.rect(x + 0.5, y + 1.0) :
            d === 4 ? Vector.rect(x, y + 0.5) :
            d === 8 ? Vector.rect(x + 0.5, y) :
            null
        );
    }
    return null;
};

// コーナー判定
Game_CharacterBase.prototype.isCorner = function(x, y, d) {
    var hD = this.horizontalDirection(d);
    var vD = this.varticalDirection(d);
    var oX = $gameMap.roundXWithDirection(x, hD);
    var oY = $gameMap.roundYWithDirection(y, vD);
    return (
        !this.isEdge(x, y, hD) &&
        !this.isEdge(x, y, vD) &&
        this.isEdge(x, oY, hD) &&
        this.isEdge(oX, y, vD)
    );
};

// 水平方向
Game_CharacterBase.prototype.horizontalDirection = function(d) {
    var modD = d % 3;
    return (
        modD === 0 ? 6 :
        modD === 1 ? 4 :
        5
    );
};

// 垂直方向
Game_CharacterBase.prototype.varticalDirection = function(d) {
    var quoD = Math.ceil(d / 3);
    return (
        quoD === 1 ? 2 :
        quoD === 3 ? 8 :
        5
    );
};

// コーナー座標
Game_CharacterBase.prototype.cornerPos = function(x, y, d) {
    if (this.isCorner(x, y, d)) {
        return (
            d === 3 ? Vector.rect(x + 1.0, y + 1.0) :
            d === 1 ? Vector.rect(x, y + 1.0) :
            d === 7 ? Vector.rect(x, y) :
            d === 9 ? Vector.rect(x + 1.0, y) :
            null
        );
    }
    return null;
};

//-----------------------------------------------------------------------------
// Game_Characetr
//
// キャラクター

// 移動コマンドコードリスト
Game_Character.moveRouteCommmandCodes = [
    Game_Character.ROUTE_MOVE_DOWN,
    Game_Character.ROUTE_MOVE_LEFT,
    Game_Character.ROUTE_MOVE_RIGHT,
    Game_Character.ROUTE_MOVE_UP,
    Game_Character.ROUTE_MOVE_LOWER_L,
    Game_Character.ROUTE_MOVE_LOWER_R,
    Game_Character.ROUTE_MOVE_UPPER_L,
    Game_Character.ROUTE_MOVE_UPPER_R,
    Game_Character.ROUTE_MOVE_RANDOM,
    Game_Character.ROUTE_MOVE_TOWARD,
    Game_Character.ROUTE_MOVE_AWAY,
    Game_Character.ROUTE_MOVE_FORWARD,
    Game_Character.ROUTE_MOVE_BACKWARD
];

// メンバー変数の初期化
var _Game_Character_initMembers =
    Game_Character.prototype.initMembers
Game_Character.prototype.initMembers = function() {
    _Game_Character_initMembers.call(this);
    this._processingRouteCommand = null;
};

// 移動ルートコマンド判定
Game_Character.prototype.isMoveRouteCommand = function(command) {
    if (!command) {
        return false;
    }
    var code = command.code;
    return Game_Character.moveRouteCommmandCodes.indexOf(code) !== -1;
};

// 現在ルートコマンド
Game_Character.prototype.nextRouteCommand = function() {
    var command = this._moveRoute.list[this._moveRouteIndex] || null;
    return command;
};

// 処理中ルートコマンド
Game_Character.prototype.processingRouteCommand = function() {
    return this._processingRouteCommand
};

// ルートコマンドの処理
var _Game_Character_processMoveCommand =
    Game_Character.prototype.processMoveCommand;
Game_Character.prototype.processMoveCommand = function(command) {
    _Game_Character_processMoveCommand.call(this, command);
    this._processingRouteCommand = command;
};

// ルート終了処理
var _Game_Character_processRouteEnd =
    Game_Character.prototype.processRouteEnd;
Game_Character.prototype.processRouteEnd = function() {
    _Game_Character_processRouteEnd.call(this);
    this._processingRouteCommand = null;
};

//-----------------------------------------------------------------------------
// Game_Player
//
// プレイヤー

// オブジェクト初期化
var _Game_Player_initialize =
    Game_Player.prototype.initialize;
Game_Player.prototype.initialize = function() {
    _Game_Player_initialize.call(this);
    this.initMover();
};

// メンバー変数の初期化
var _Game_Player_initMembers =
    Game_Player.prototype.initMembers;
Game_Player.prototype.initMembers = function() {
    _Game_Player_initMembers.call(this);
    this._moveDefault = false;
};

// ムーバーの初期化
Game_Player.prototype.initMover = function() {
    this._mover = new PlayerMover(this);
    this._ignoringEventIds = [];
    this._stepDistance = 0.0;
};

// ムーバー
Game_Player.prototype.mover = function() {
    return this._mover;
};

// すり抜け判定
var _Game_Player_isThrough =
    Game_Player.prototype.isThrough;
Game_Player.prototype.isThrough = function() {
    if (this.hasMover()) {
        return (
            this._vehicleGettingOn ||
            this._vehicleGettingOff ||
            _Game_Player_isThrough.call(this)
        );
    }
    return _Game_Player_isThrough.call(this);
};

// 移動中判定
var _Game_Player_isMoving =
    Game_Player.prototype.isMoving;
Game_Player.prototype.isMoving = function() {
    if (!SceneManager.isSceneActive()) {
        return false;
    } else if (this.shouleMoveDefault()) {
        return _Game_Player_isMoving.call(this);
    } else if (this.canAnalogMove()) {
        return this._mover.isMoving();
    }
    return false;
};

// デフォルト移動判定
Game_Player.prototype.shouleMoveDefault = function() {
    return (
        this._moveDefault ||
        this._vehicleGettingOn ||
        this._vehicleGettingOff
    );
};

// フレーム更新
var _Game_Player_update =
    Game_Player.prototype.update;
Game_Player.prototype.update = function(sceneActive) {
    if (this.canAnalogMove()) {
        var lastScrolledX = this.scrolledX();
        var lastScrolledY = this.scrolledY();
        this.updateAnalogDashing();
        Game_Character.prototype.update.call(this);
        this.updateScroll(lastScrolledX, lastScrolledY);
        this.updateSteps();
        this.updateVehicle();
        this.updateFollowers();
        this.updateAction();
        this.updateDistination();
        this.updateIgnoringEventIds();
        return;
    }
    if (this.hasMover()) {
        this.updateDistination();
    }
    _Game_Player_update.call(this, sceneActive);
};

// アナログムーブ時のダッシュ判定の更新
Game_Player.prototype.updateAnalogDashing = function() {
    this._dashing = (
        this.canMove() &&
        !this.isInVehicle() &&
        !$gameMap.isDashDisabled() && (
            this.isDashButtonPressed() ||
            $gameTemp.isDestinationValid()
        )
    );
};

// 移動の更新
var _Game_Player_updateMove =
    Game_Player.prototype.updateMove;
Game_Player.prototype.updateMove = function() {
    if (this.shouleMoveDefault()) {
        _Game_Player_updateMove.call(this);
        this._moveDefault = this.isMoving();
    }
};

// 乗り物下乗の更新
var _Game_Player_updateVehicleGetOff =
    Game_Player.prototype.updateVehicleGetOff;
Game_Player.prototype.updateVehicleGetOff = function() {
    if (this.hasMover() && this.isMoving()) { 
        return;
    }
    _Game_Player_updateVehicleGetOff.call(this);
};

// ステップの更新
Game_Player.prototype.updateSteps = function() {
    this._stepDistance += this._mover.distanceMoved();
    if (this._stepDistance > 1.0) {
        this._stepDistance -= 1.0;
        if (this.canEncounter()) {
            this._encounterCount -= this.encounterProgressValue();
        }
        this.increaseSteps();
        $gameParty.onPlayerWalk();
    }
};

// フォロワーズの更新
Game_Player.prototype.updateFollowers = function() {
    this._followers.update();
};

// アクションの更新
Game_Player.prototype.updateAction = function() {
    if (!$gameMap.isEventRunning()) {
        if (this.isMoving()) {
            this.checkEventTriggerHere([1,2]);
            if ($gameMap.setupStartingEvent()) {
                return;
            }
        }
        this.checkEventTriggerTouchFront(5);
        if ($gameMap.setupStartingEvent()) {
            return;
        }
        this.triggerAction();
    }
};

// 目標座標の更新
Game_Player.prototype.updateDistination = function() {
    if (!this.canMove() || !this.isMoving()) {
        if ($gameTemp.isDestinationValid()) {
            $gameTemp.clearDestination();
        }
        if (this.hasMover()) {
            this._mover.clearTargetPosition();
        }
    }
};

// タッチによるイベント起動の確認
var _Game_Player_triggerTouchAction =
    Game_Player.prototype.triggerTouchAction;
Game_Player.prototype.triggerTouchAction = function() {
    if (this.canAnalogMove()) {
        if ($gameTemp.isDestinationValid()) {
            var froPosVec = this._mover.froPosVec();
            var x1 = this._x;
            var y1 = this._y;
            var x2 = Math.floor(froPosVec.x());
            var y2 = Math.floor(froPosVec.y());
            var destX = $gameTemp.destinationX();
            var destY = $gameTemp.destinationY();
            if (destX === x1 && destY === y1) {
                return this.triggerTouchActionD1(x1, y1);
            } else if (destX === x2 && destY === y2) {
                return this.triggerTouchActionD2(x2, y2);
            }
        }
        return false;
    }
    return _Game_Player_triggerTouchAction.call(this);
};

// 隣接タイルのイベント起動確認
var _Game_Player_checkEventTriggerThere =
    Game_Player.prototype.checkEventTriggerThere;
Game_Player.prototype.checkEventTriggerThere = function(triggers) {
    if (this.canAnalogMove()) {
        if (this.canStartLocalEvents()) {
            var froPosVec = this._mover.froPosVec();
            var x2 = Math.floor(froPosVec.x());
            var y2 = Math.floor(froPosVec.y());
            this.startMapEvent(x2, y2, triggers, true);
        }
        return;
    }
    _Game_Player_checkEventTriggerThere.call(this, triggers);
};

// 正面タイルのイベント起動確認
var _Game_Player_checkEventTriggerTouchFront =
    Game_Player.prototype.checkEventTriggerTouchFront;
Game_Player.prototype.checkEventTriggerTouchFront = function(d) {
    if (this.canAnalogMove()) {
        if (this.canStartLocalEvents()) {
            this.startCollidingMapEvents();
        }
        return;
    }
    _Game_Player_checkEventTriggerTouchFront.call(this, d);
};

// 接触イベントの開始
Game_Player.prototype.startCollidingMapEvents = function() {
    if (!$gameMap.isEventRunning()) {
        var eventIds = this._mover.collidingEventIds();
        var events = eventIds.map(
            function(eventId) {
                return $gameMap.event(eventId);
            }
        );
        events.forEach(
            function(event) {
                if (event.isCollideTriggerEvent() &&
                    event.isNormalPriority())
                {
                    event.start();
                }
            }
        );
    }
};

// 無視イベントIDリストの更新
Game_Player.prototype.updateIgnoringEventIds = function() {
    this._ignoringEventIds = this._ignoringEventIds.filter(
        function(eventId) {
            var event = $gameMap.event(eventId);
            return event.posNt(this._x, this._y);
        }, this
    );
};

// 無視イベントIDの追加
Game_Player.prototype.addIgnoringEventId = function(eventId) {
    if (!this.isIgnoringEventId(eventId)) {
        this._ignoringEventIds.push(eventId);
    }
};

// 無視イベントID判定
Game_Player.prototype.isIgnoringEventId = function(eventId) {
    return this._ignoringEventIds.indexOf(eventId) !== -1;
};

// デフォルト移動確認
Game_Player.prototype.checkMoveDefault = function() {
    if (this.isMoveRouteCommand(this.nextRouteCommand()) ||
        this.isMoveRouteCommand(this.processingRouteCommand()))
    {
        this._moveDefault = true;
        this._followers.forEach(
            function(follower) {
                follower.checkMoveDefault();
            }
        );
    }
};

// 移動ルートの強制
var _Game_Player_forceMoveRoute =
    Game_Player.prototype.forceMoveRoute;
Game_Player.prototype.forceMoveRoute = function(moveRoute) {
    _Game_Player_forceMoveRoute.call(this, moveRoute);
    this.checkMoveDefault();
};

// 移動ルートインデックスの進行
var _Game_Player_advanceMoveRouteIndex =
    Game_Player.prototype.advanceMoveRouteIndex;
Game_Player.prototype.advanceMoveRouteIndex = function() {
    _Game_Player_advanceMoveRouteIndex.call(this);
    if(!!this._moveRoute) {
        this.checkMoveDefault();
    }
};

// 場所移動の実行
var _Game_Player_performTransfer =
    Game_Player.prototype.performTransfer;
Game_Player.prototype.performTransfer = function() {
    if (this.isTransferring()) {
        if (this._newMapId !== $gameMap.mapId() ||
            this._needsMapReload)
        {
            this._ignoringEventIds = [];
        }
    }
    _Game_Player_performTransfer.call(this);
    $gameMap.eventsXy(this._x, this._y).forEach(
        function(event) {
            this.addIgnoringEventId(event.eventId());
        }, this
    );
};

// アナログムーブ可能判定
Game_Player.prototype.canAnalogMove = function() {
    return (
        SceneManager.isSceneActive() &&
        this.hasMover() &&
        this.canMove() &&
        !this.isJumping() &&
        !this.isMoveRouteForcing() &&
        !this.shouleMoveDefault()
    );
};

//-----------------------------------------------------------------------------
// Game_Follower
//
// フォロワー

// オブジェクト初期化
var _Game_Follower_initialize =
    Game_Follower.prototype.initialize;
Game_Follower.prototype.initialize = function(memberIndex) {
    _Game_Follower_initialize.call(this, memberIndex);
    this.initMover();
};

// メンバー変数の初期化
var _Game_Follower_initMembers =
    Game_Follower.prototype.initMembers;
Game_Follower.prototype.initMembers = function() {
    _Game_Follower_initMembers.call(this);
    this._moveDefault = false;
};

// ムーバーの初期化
Game_Follower.prototype.initMover = function() {
    this._mover = new FollowerMover(this);
};

// ムーバー
Game_Follower.prototype.mover = function() {
    return this._mover;
};

// すり抜け判定
var _Game_Follower_isThrough =
    Game_Follower.prototype.isThrough;
Game_Follower.prototype.isThrough = function() {
    if (this.canAnalogMove()) {
        return (
            !this.isVisible() ||
            $gamePlayer.isThrough()
        );
    }
    return _Game_Follower_isThrough.call(this)
};

// フォロワーインデックス
Game_Follower.prototype.followerIndex = function() {
    return this._memberIndex - 1;
};

// 移動中判定
var _Game_Follower_isMoving =
    Game_Follower.prototype.isMoving;
Game_Follower.prototype.isMoving = function() {
    if (!SceneManager.isSceneActive()) {
        return false;
    } else if (this.shouleMoveDefault()) {
        return _Game_Follower_isMoving.call(this);
    } else if (this.canAnalogMove()) {
        return this._mover.isMoving();
    }
    return false;
};

// 実移動速度
Game_Follower.prototype.realMoveSpeed = function() {
    return this._moveSpeed;
};

// ダッシュ中判定
Game_Follower.prototype.isDashing = function() {
    return $gamePlayer.isDashing();
};

// デフォルト移動判定
Game_Follower.prototype.shouleMoveDefault = function() {
    return this._moveDefault;
};

// フレーム更新
var _Game_Follower_update =
    Game_Follower.prototype.update;
Game_Follower.prototype.update = function() {
    _Game_Follower_update.call(this);
    if (this.shouleMoveDefault()) {
        this.checkMoveDefault();
    }
};

// 移動の更新
var _Game_Follower_updateMove =
    Game_Follower.prototype.updateMove;
Game_Follower.prototype.updateMove = function() {
    if (this.shouleMoveDefault()) {
        _Game_Follower_updateMove.call(this);
        this._moveDefault = this.isMoving();
    }
};

// 隊列内の前のキャラクター
Game_Follower.prototype.precedingCharacter = function() {
    return (this.followerIndex() > 0 ? 
        $gamePlayer.followers().follower(this.followerIndex() - 1) :
        $gamePlayer
    );
};

// デフォルト移動確認
Game_Follower.prototype.checkMoveDefault = function() {
    this._moveDefault = $gamePlayer.shouleMoveDefault();
};

// 移動可能判定
Game_Follower.prototype.canMove = function() {
    return $gamePlayer.canMove();
};

// アナログムーブ可能判定
Game_Follower.prototype.canAnalogMove = function() {
    return (
        this.hasMover() &&
        !this.shouleMoveDefault() && (
            $gamePlayer.canAnalogMove() ||
            $gamePlayer.areFollowersGathering()
        )
    );
};

//-----------------------------------------------------------------------------
// Game_Followers
//
// フォロワーズ

// フォロワーリスト
Game_Followers.prototype.followers = function() {
    return this._data;
};

//-----------------------------------------------------------------------------
// Game_Event
//
// イベント

// イベントの開始
var _Game_Event_start =
    Game_Event.prototype.start;
Game_Event.prototype.start = function() {
    if ($gamePlayer.isIgnoringEventId(this._eventId)) {
        return;
    }
    _Game_Event_start.call(this);
    if (this.shouldIgnore()) {
        $gamePlayer.addIgnoringEventId(this._eventId);
    }
};

// 無視判定
Game_Event.prototype.shouldIgnore = function() {
    return (
        this.isCollideTriggerEvent() &&
        $gamePlayer.posNt(this._x, this._y)
    );
};

// 接触トリガー判定
Game_Event.prototype.isCollideTriggerEvent = function() {
    var collideTriggers = [1, 2];
    return this.isTriggerIn(collideTriggers);
};

//-----------------------------------------------------------------------------
// Game_Map
//
// マップ

// 全てのキャラクター
Game_Map.prototype.allCharacters = function() {
    var characters = [].concat(
        $gamePlayer,
        $gamePlayer.followers().followers(),
        $gameMap.events(),
        $gameMap.vehicles()
    );
    return characters;
};

// パーティーキャラクター
Game_Map.prototype.partyCharacters = function() {
    var characters = [].concat(
        $gamePlayer,
        $gamePlayer.followers().followers()
    );
    return characters;
};

// ムーバーの初期化
Game_Map.prototype.initCharacterMovers = function() {
    $gameMap.partyCharacters().forEach(
        function(character) {
            character.initMover();
        }
    );
};

//-----------------------------------------------------------------------------
// Scene_Map
//
// マップシーン

// マップロード完了処理
var _Scene_Map_onMapLoaded =
    Scene_Map.prototype.onMapLoaded;
Scene_Map.prototype.onMapLoaded = function() {
    $gameMap.initCharacterMovers();
    _Scene_Map_onMapLoaded.call(this);
};

// メニュー呼び出し可能判定
var _Scene_Map_updateCallMenu =
    Scene_Map.prototype.updateCallMenu;
Scene_Map.prototype.updateCallMenu = function() {
    if ($gamePlayer.canAnalogMove()) {
        if (this.isMenuCalled() && this.isMenuEnabled()) {
            this.callMenu();
        }
        return;
    }
    _Scene_Map_updateCallMenu.call(this);
};

//-----------------------------------------------------------------------------
// SceneManager
//
// シーンマネージャー

// シーンアクティブ判定
SceneManager.isSceneActive = function() {
    return !!this._scene.isActive && this._scene.isActive();
};

//-----------------------------------------------------------------------------
// window
//
// グローバル領域

// オブジェクト登録
window.Vector = Vector;
window.CharacterMover = CharacterMover;
window.PlayerMover = PlayerMover;
window.FollowerMover = FollowerMover;

})();
