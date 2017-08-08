/**
 *  Class for writing game logic functions and steps in a more readable way.
 * Purpose is to remove game logic from server.js, which I would like to basically just have framework code.
 */
var config = require('../../../config.json');
var Wall = require('./wall');
var Bullet = require('./bullet');
var Track = require('./track');
var util = require('./util');
var winston = require('winston');
winston.level = 'debug';


class GameLogicService {
    constructor(quadtreeManager) {
        this.quadtreeManager = quadtreeManager;
        this.quadtree = quadtreeManager.getQuadtree();
    }

    initializeGame() {
        /**
         * Initialize border walls, put them in the quadtree
         * I'm still not sure I want to use the quadtree to store data for the borders.
         * I don't know how much it will help us, it might even not help. 
         */
        var leftBorderWall = new Wall(0, 0, config.wallWidth, config.gameHeight);
        var topBorderWall = new Wall(config.wallWidth, 0, config.gameWidth - 2 * config.wallWidth, config.wallWidth);
        var rightBorderWall = new Wall(config.gameWidth - config.wallWidth, 0, config.wallWidth, config.gameHeight);
        var bottomBorderWall = new Wall(config.wallWidth, config.gameHeight - config.wallWidth, config.gameWidth - 2 * config.wallWidth, config.wallWidth);

        this.quadtree.put(leftBorderWall.forQuadtree());
        this.quadtree.put(topBorderWall.forQuadtree());
        this.quadtree.put(rightBorderWall.forQuadtree());
        this.quadtree.put(bottomBorderWall.forQuadtree());
    }

    gameTick(clientData, socket, currentClientDatas) {
        var currentTime = new Date().getTime();

        this.kickPlayerIfIdle(clientData, socket, currentTime);
        this.updatePlayerPosition(clientData);
        this.increaseAmmoIfNecessary(clientData,currentTime);
        this.updatePositionsOfBullets(clientData);
        this.fireBulletsIfNecessary(clientData, currentTime);
        this.removeBulletsThatAreOutOfBounds(clientData, currentClientDatas);
        this.handleCollisionsOnTank(clientData, currentClientDatas);
        this.updateTracks();
    }

    kickPlayerIfIdle(clientData, socket, time){
        /**
         * Kick player if idle
         */
        if(clientData.lastHeartbeat < time - config.maxLastHeartBeat) {
            winston.log('debug',`Kicking player ${clientData.player.screenName}`);
            socket.emit('kick');
            socket.disconnect();
        }
    };

    updatePlayerPosition(clientData){
        /**
         * Set tank gun angle
         */
        if(typeof clientData.player.userInput.mouseAngle !== 'undefined'){
            clientData.tank.gunAngle = clientData.player.userInput.mouseAngle;
        }

        var oldQuadreeInfo = clientData.forQuadtree();
        var oldPosition = clientData.position;
        var newPosition = {
            x: clientData.position.x,
            y: clientData.position.y
        };

        /**
         *  Update player position based on input
         */

        // Check if user's position should move UP
        if(clientData.player.userInput.keysPressed['KEY_UP'] &&
            !clientData.player.userInput.keysPressed['KEY_DOWN']) {
            newPosition.y = oldPosition.y - config.player.speedFactor;
        }
        // Check if user's position should move DOWN
        else if(clientData.player.userInput.keysPressed['KEY_DOWN'] &&
            !clientData.player.userInput.keysPressed['KEY_UP']) {
            newPosition.y = oldPosition.y + config.player.speedFactor;
        }

        // Check if user's position should move RIGHT
        if(clientData.player.userInput.keysPressed['KEY_RIGHT'] &&
            !clientData.player.userInput.keysPressed['KEY_LEFT']) {
            newPosition.x = oldPosition.x + config.player.speedFactor;
        }
        // Check if user's position should move LEFT
        else if(clientData.player.userInput.keysPressed['KEY_LEFT'] &&
            !clientData.player.userInput.keysPressed['KEY_RIGHT']) {
            newPosition.x = oldPosition.x - config.player.speedFactor;
        }

        // Check if tank has moved since last update
        // (Necessary to check because otherwise tank's direction will keep going
        // back to North every time that it stops moving)
        if(!util.areCoordinatesEqual(oldPosition, newPosition)) {
            // Tank has moved so update its direction
            var angleInRadians = Math.atan2(newPosition.y - oldPosition.y, newPosition.x - oldPosition.x);
            clientData.tank.hullAngle = angleInRadians;

            // Update tank's frame since tank is moving
            clientData.tank.spriteTankHull.update();

            // Add new tank track since tank has changed location
            var track = new Track(newPosition.x, newPosition.y);
            this.quadtree.put(track.forQuadtree());
        }

        clientData.position = newPosition;

        /**
        * Update the item on the quadtree
        */
        this.quadtree.update(oldQuadreeInfo, 'id', clientData.forQuadtree());
    };

    increaseAmmoIfNecessary(clientData, time){
        /**
         * Increase ammo if necessary
         */
        if(clientData.tank.ammo < config.tankAmmoCapacity && ((time - clientData.tank.lastAmmoEarned > config.tankTimeToGainAmmo) || typeof clientData.tank.lastAmmoEarned === 'undefined')){
            clientData.tank.ammo = clientData.tank.ammo + 1;
            clientData.tank.lastAmmoEarned = time;
        }
    };

    updatePositionsOfBullets(clientData){
        /**
        * Update positions of all the bullets
        */
        for(var bullet of clientData.tank.bullets) {

            let oldTreeInfo = bullet.forQuadtree();
            bullet.x = bullet.x + bullet.velocityX;
            bullet.y = bullet.y - bullet.velocityY;
            let forQuadtree = bullet.forQuadtree();
            if(!this.quadtree.update(oldTreeInfo, 'id', forQuadtree)){
                throw new Error(`Unable to update bullet ${bullet.id} in quadtree, this should not happen.`);
            }
        }
    };

    fireBulletsIfNecessary(clientData, time){
        /**
        * Fire bullets if necessary
        */
        if(typeof clientData.player.userInput.mouseClicked !== 'undefined') {
            if(clientData.player.userInput.mouseClicked &&
                clientData.tank.ammo > 0 &&
                (typeof clientData.tank.lastFireTime === 'undefined' ||
                (time - clientData.tank.lastFireTime > config.tankFireTimeWait))) {

                clientData.tank.lastFireTime = time;
                clientData.tank.ammo = clientData.tank.ammo - 1;

                var xComponent = Math.cos(clientData.tank.gunAngle);
                var yComponent = Math.sin(clientData.tank.gunAngle);

                var bullet = new Bullet(clientData.id,
                    clientData.tank.x + (xComponent * config.tankBarrelLength),
                    clientData.tank.y - (yComponent * config.tankBarrelLength),
                    xComponent * config.bulletVelocity,
                    yComponent * config.bulletVelocity);

                this.quadtree.put(bullet.forQuadtree());
                clientData.tank.bullets.push(bullet);
            }
        }
    };
    
    removeBulletsThatAreOutOfBounds(clientData, currentClientDatas){
        /**
        * Remove any bullets that are now out of bounds.
        */
        for(var bullet of clientData.tank.bullets) {
            if(bullet.x > config.gameWidth - config.wallWidth || bullet.x < config.wallWidth || bullet.y > config.gameHeight - config.wallWidth || bullet.y < config.wallWidth){
                var playerIndex = util.findIndex(currentClientDatas,bullet.ownerId);
                if(playerIndex > -1) {
                    var bulletIndex = util.findIndex(currentClientDatas[playerIndex].tank.bullets, bullet.id);
                    if(bulletIndex > -1){
                        currentClientDatas[playerIndex].tank.bullets.splice(bulletIndex,1);
                        this.quadtree.remove(bullet.forQuadtree(), 'id');
                    }else{
                        throw new Error(`Bullet index is ${bulletIndex}, how you gonna remove that??`);
                    }
                }else{
                    throw new Error(`Player index is ${playerIndex}, how you gonna remove that??`);
                }
            }
        }
    };

    handleCollisionsOnTank(clientData, currentClientDatas){
        /**
         * Check any collisions on tank
         */
        var objectsInTankArea = this.quadtree.get(clientData.tank.forQuadtree());
        for(var objectInTankArea of objectsInTankArea){
            if(objectInTankArea.type === 'BULLET'){
                var bullet = objectInTankArea.object;
                var playerIndex = util.findIndex(currentClientDatas,bullet.ownerId);

                //update that player's score
                currentClientDatas[playerIndex].tank.kills = currentClientDatas[playerIndex].tank.kills + 1;

                if(playerIndex > -1) {
                    var bulletIndex = util.findIndex(currentClientDatas[playerIndex].tank.bullets, bullet.id);
                    if(bulletIndex > -1){
                        currentClientDatas[playerIndex].tank.bullets.splice(bulletIndex,1);
                        this.quadtree.remove(bullet.forQuadtree(), 'id');
                    }else{
                        throw new Error(`Bullet index is ${bulletIndex}, how you gonna remove that??`);
                    }
                }else{
                    throw new Error(`Player index is ${playerIndex}, how you gonna remove that??`);
                }
            }
        }
    }

    updateTracks() {

        // var visibleTracks = this.quadtreeManager.queryGameObjectsForType('TRACK');
        // console.log(visibleTracks);

        // visibleTracks.forEach(function(track) {
            // Check if track should disappear
            // if(Track.hasExpired(track.tickCount)) {
                // Remove track by uniquely identifiable attribute
                // this.quadtree.remove(track, 'id');
            // }
            // else {
                // this.quadtree.remove(track, 'id');
            // }
        // });
    };

}

module.exports = GameLogicService;