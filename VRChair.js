import {
  Mesh,
  DoubleSide,
  VideoTexture,
  ShaderMaterial,
  Vector3,
  Quaternion,
  MeshBasicMaterial
} from 'three';

import gsap, { RoughEase, Linear } from 'gsap/all';
import { SCENE_INTERACTION } from '../../constants/scene';
import { NEW_WEBRTC_EVENTS, WEBRTC_EVENTS } from '../../constants/webrtc';
import { SCENE_EVENTS } from '../MVC/Model';
import { videoTextureShaderProps } from './constants/shader';
import { createLeftMaterial } from './constants/leftImageShader';

import { VRProfileHelper } from './VRProfileHelper';
import { animateCamera, waitForElement } from './helpers/worldHelpers';

import {
  chairCircleGeometry,
  chairPlaneGeometry,
  textureLoader,
  defaultTexture,
  videoMaterials,
  savedStreamInfo,
  emptyMaterial
} from './helpers/texturesAndGeometries';
import { GLOBAL_EVENTS } from '../../constants/global';

import { WebRtc } from '../WebRTC/_WebRtc';
import { SOCKET_EVENTS } from '../../socket/Socket';
import { ANT_MEDIA_SERVER_BAGELSS_EVENTS, states } from '../WebRTC/constants';
import { createRightMaterial } from './constants/rightImageShader';


class VRChair extends VRProfileHelper {

  constructor(containerName, camera, texture, x, y, z, model) {

    super(containerName, camera, texture, model);

    this.state = {
      occupied: false,
      me: false,
      videoOn: false,
      avatarImage: null,
      webcamStreamId: null,
    }

    this.iSitOnIt = false;
    this.emptySeat = true;

    this.limits = {
      min: 115,
      max: 570,
      distance: 300
    }
    this.isVideoStarted = false;

    this.isVideoTexture = false;
    this.videoElement = null;

    this.requestAudioLevels = false;
    this.averageVolume = 0;
    this.requestFakeAnimation = true;
    this.videoElementFromSelector;
    this.userVideoElementFromSelector;

    this.videoMaterial = new ShaderMaterial({
      uniforms: {
        tex: {
          value: null
        },
        ratio: {
          value: 0
        },
        isPortrait: {
          value: false
        },
        isMirror: {
          value: false
        }
      },
      side: DoubleSide,
      transparent: true,
      depthWrite: true,
      depthTest: true,
      vertexShader: videoTextureShaderProps.vertexShader,
      fragmentShader: videoTextureShaderProps.fragmentShader,
    });

    this.leftImageMaterial = createLeftMaterial();
    this.emptySeatTexture = texture;

    this.mesh = new Mesh(this.model.editMode ? chairPlaneGeometry : chairCircleGeometry, this.material);
    this.mesh.renderOrder = 1;
    this.mesh.translateZ(4);
    this.mesh.type = 'guestSeat';
    this.mesh.name = 'guestSeat';
    // this.newMood = new NoisyCircle(40, 128, 128, this.model.noise, 0.1);
    // this.newMoodMesh = this.newMood.mesh;
    // this.mesh.add(this.newMoodMesh);
    // this.newMoodMesh.translateZ(10);

    this.meshVideo = new Mesh(this.model.editMode ? chairPlaneGeometry : chairCircleGeometry, this.material);
    // this.meshVideo.renderOrder = 1;
    // this.meshVideo.translateZ(4);
    // this.meshVideo.type = 'guestSeat';
    // this.meshVideo.name = 'guestSeat';

    // !this.model.editMode && this.mesh.add(this.meshVideo);

    this.add(this.mesh);

    this.camera !== null ? this._setInitialPosRot() : this.setPosition(x, y, z);

    this.mesh.groupDetails = { title: this.model.languageObject['chair'].text, icon: 'chair', editTitle: this.model.languageObject['edit-chair'].text, dataLang: 'edit-chair' }

    // this.editControls();

    !this.model.editMode && this.addMood();
    !this.model.editMode && this.addBorder();


    // !this.model.editMode && this.addBusyOnCall();

    const self = this;

    screen.orientation && screen.orientation.addEventListener('change', this.fixRaportRatio); // TODO - walkaround for screen on safari browser
    this.userInfo = this.userData;


    //// camera / avatar for USER handler
    this.handleUserWantsCamera = () => {
      const videoElement = this.model.getCameraHTMLObject()
      this.videoElement = videoElement;
      if (!videoMaterials["user"]) {
        this.userVideoElementFromSelector = videoElement
        this.startVideo(videoElement);
        videoMaterials["user"] = new VideoTexture(videoElement);
      } else {
        this.videoMaterial.uniforms.tex.value = videoMaterials["user"];
        this.leftImageMaterial.uniforms.tex.value = videoMaterials["user"];
      }
      this.takeSeat(true);
      this.fixRaportRatio();
    }
    this.handleUserWantsAvatar = () => {
      this.setAvatarImage(this.model.config.userAvatarUrl)
      this.takeSeat(true);
    }

    ///new 
    this.occupedWithoutStream = () => {
      const state = this.getState();
      if (state.occupied) {
        if (state.me) {
          if (state.videoOn) {
            this.handleUserWantsCamera();
          } else {
            this.handleUserWantsAvatar();
          }
        } else {
          if (state.videoOn) {
            this.startVideoStream(state.webcamStreamId)
          } else {
            this.setAvatarImage(state.avatarImage)
          }
        }
      }
      else {
        this.standUp();
      }
    }

    this.isSeatOccupiedByUser = () => {
      if (this.model.editMode) {
        return;
      }
      this.iSitOnIt = false;
      const occupiedSeats = this.model.socket.getOccupiedSeats();
      if (occupiedSeats[this.dbConfig.id] && occupiedSeats[this.dbConfig.id] === this.model.config.userId) {
        this.iSitOnIt = true;
      }
      if (!occupiedSeats[this.dbConfig.id]) {
        this.webcamStreamId = null;
        this.standUp()
      }
      if (occupiedSeats[this.dbConfig.id]) {
        this.occupySeat(this.model.socket.getUsersObject()[occupiedSeats[this.dbConfig.id]])
      }
      return occupiedSeats[this.dbConfig.id];
    }

    this.model.addEventListener(SCENE_INTERACTION.SCENE_INITIALISED, async (e) => {
      this.occupedWithoutStream();
    });
    this.model.addEventListener(SCENE_EVENTS.USER_INVERTS_CAMERA, async (e) => {
      if (this.model.view.deviceSettingsMenu.selected.userCameraInverted) {
        this.invertCamera();
      } else {
        this.normaliseCamera();
      }
    });
    this.model.addEventListener(SCENE_INTERACTION.SOCKET_USER_INFO_CHANGED, async (e) => {
      // this.onInvertCamera();
    });

    this.model.addEventListener(ANT_MEDIA_SERVER_BAGELSS_EVENTS.LEAVE_ROOM_SUCCESS, async (e) => {
      this.occupedWithoutStream();
    });

    this.model.addEventListener(SCENE_EVENTS.SOMEONE_SPOKE, (e) => {
      if (state.occupied && !this.videoElement) {
        if (state.me) {
        } else {
          const { userId } = this.userData;
          if (userId && e.data[userId]) {
            const audioLevels = e.data[userId].audioLevels;
            if (audioLevels) {
              const amplitude = parseFloat(`1.${audioLevels / 10}`);
              this.requestFakeAnimation = true;
              this.fakeAudioLevelsAnimation(amplitude);
            }
          }
          else {
            this.requestFakeAnimation = false;
          }
        }
      }
    });

    ////user started share publish, due to delayed call need to recreate texture, happends once
    this.model.addEventListener("USER_STARTED_SCREEN_SHARE_PUBLISH", (e) => {
      const occupiedBy = this.isSeatOccupiedByUser()
      if (occupiedBy && (occupiedBy === this.model.config.userId)) {
        ////its me
        const video = this.model.getCameraHTMLObject();
        const { id } = video;
        videoMaterials[id] = new VideoTexture(video);
        this.handleUserWantsCamera();
        // const data = this.model.socket.getUsers()[occupiedBy];
        // const { userAvatarUrl, userVideoOn } = data;
        // if (!userVideoOn) {
        //   this.setAvatarImage(userAvatarUrl)
        // }
      }
    });



    ///turn on and off camera 
    this.model.addEventListener(SOCKET_EVENTS.USER_VIDEO_STATE_CHANGED, (e) => {
      const occupiedBy = this.isSeatOccupiedByUser()
      if (occupiedBy) {
        this.setInitialMeshVisibility();
        if (occupiedBy === this.model.config.userId) {
          ///its me
          if (this.model.userWantsCamera) {
            this.handleUserWantsCamera();
          } else {
            this.handleUserWantsAvatar();
          }
        }
        else {
          // const data = this.model.socket.getUsers()[occupiedBy];
          // const { webcamStreamId, userAvatarUrl, userVideoOn } = data;
          // if (userVideoOn && webcamStreamId) {
          //   this.startVideoStream(webcamStreamId)
          // } else {
          //   this.setAvatarImage(userAvatarUrl)
          // }
          this.showRightMaterial();
        }
      }
    });
    this.model.addEventListener(ANT_MEDIA_SERVER_BAGELSS_EVENTS.STREAM_INFO, (e) => {
      this.fixRaportRatio();
    });

    this.model.addEventListener(SCENE_INTERACTION.USER_TOGGLE_CAMERA_ON_CTA_MENU, async (e) => {
      const state = this.getState();
      if (!state.occupied) {
        this.standUp();
        return;
      }
      this.showRightMaterial();
    });
    this.model.addEventListener(SCENE_INTERACTION.SET_OCCUPIED_SEATS, async (e) => {
      const state = this.getState();
      if (!state.occupied) {
        this.standUp();
        return;
      }
      this.showRightMaterial();
    });
    this.model.addEventListener(SCENE_INTERACTION.SET_OCCUPIED_SCREEN_SHARE_SEATS, async (e) => {
      const state = this.getState();
      if (!state.occupied) {
        this.standUp();
        return;
      }
      this.showRightMaterial();
    });
    this.model.addEventListener(SCENE_INTERACTION.SOCKET_USER_INFO_CHANGED, async (e) => {
      const state = this.getState();
      if (!state.occupied) {
        this.standUp();
        return;
      }
      this.showRightMaterial();
    });
    // this.model.addEventListener(SCENE_INTERACTION.SET_OCCUPIED_SEATS, async (e) => {
    //   const occupiedBy = this.isSeatOccupiedByUser()
    //   if (occupiedBy) {
    //     this.mesh.visible = true;
    //     if (occupiedBy === this.model.config.userId) {
    //       ////its me
    //       if (this.model.userWantsCamera) {
    //         this.handleUserWantsCamera()
    //       } else {
    //         this.handleUserWantsAvatar();
    //       }
    //     }
    //     else {
    //       /// its socket user
    //       const data = this.model.socket.getUsers()[occupiedBy];
    //       const { webcamStreamId, userAvatarUrl, userVideoOn } = data;
    //       console.log("webcamStreamId")
    //       if (webcamStreamId) {
    //         this.startVideoStream(webcamStreamId)
    //       } if (!userVideoOn) {
    //         this.setAvatarImage(userAvatarUrl)
    //       }
    //     }
    //   }
    //   else {
    //     this.standUp();
    //   }
    // });
    this.model.addEventListener(SCENE_INTERACTION.USER_STOP_SCREEN, async (e) => {
      const occupiedBy = this.isSeatOccupiedByUser()
      if (occupiedBy) {
        this.setInitialMeshVisibility();
        if (occupiedBy === this.model.config.userId) {
          ////its me
          this.showRightMaterial()
          // this.mesh.material = this.material;
          this.mesh.visible = false;
        }
      }
    });
    this.model.addEventListener("ctaMenuClickEvents", (e) => {
      const state = this.getState();
      if (state.occupied) {
        if (state.me) {
          if (state.videoOn) {
            this.handleUserWantsCamera();
          } else {
            this.handleUserWantsAvatar();
          }
        } else {
          if (state.videoOn) {
            this.startVideoStream(state.webcamStreamId)
          } else {
            this.setAvatarImage(state.avatarImage)
          }
        }
      }
      else {
        this.standUp();
      }
    });
    this.model.addEventListener(ANT_MEDIA_SERVER_BAGELSS_EVENTS.JOIN_ROOM_SUCESS, async (e) => {
      const occupiedBy = this.isSeatOccupiedByUser()
      if (occupiedBy && (occupiedBy === this.model.config.userId)) {
        ////its me
        if (this.model.userWantsCamera) {
          this.handleUserWantsCamera()
        } else {
          this.handleUserWantsAvatar();
        }
      }
    });
    //// ant media recieved stream
    this.model.addEventListener("TEST_RE_CREATE_WEB_STREAMS", async (e) => {
      const occupiedBy = this.isSeatOccupiedByUser()
      if (occupiedBy) {
        if (occupiedBy === this.model.config.userId) {
          ////its me
          if (this.model.userWantsCamera) {
            this.handleUserWantsCamera();
            setTimeout(() => {
              // this.fixRaportRatio(480, 640);
            }, 1000)
          } else {
            this.handleUserWantsAvatar();
          }
        }
        else {
          this.showRightMaterial()

        }
      }
      else {

      }
    });
    this.model.addEventListener(ANT_MEDIA_SERVER_BAGELSS_EVENTS.VIDEO_CREATED, (e) => {
      const occupiedBy = this.isSeatOccupiedByUser()
      if (occupiedBy) {
        if (occupiedBy === this.model.config.userId) {
          ////its me
          if (this.model.userWantsCamera) {
            this.handleUserWantsCamera();
            setTimeout(() => {
              // this.fixRaportRatio(480, 640);
            }, 1000)
          } else {
            this.handleUserWantsAvatar();
          }
        }
        else {
          this.showRightMaterial()
        }
      }
    });

    this.model.addEventListener(SCENE_INTERACTION.SOCKET_USER_INFO_CHANGED, async (e) => {
      const state = this.getState();
      if (state.occupied) {
        if (state.me) {
          if (state.videoOn) {
            this.handleUserWantsCamera();
          } else {
            this.handleUserWantsAvatar();
          }
        } else {
          if (state.videoOn) {
            this.startVideoStream(state.webcamStreamId)
          } else {
            this.setAvatarImage(state.avatarImage)
          }
        }
      }
      else {
        this.standUp();
      }
    });
    this.model.addEventListener("REMOVE_STREAM", (e) => {
      if (this.webcamStreamId && this.webcamStreamId === e.data.id) {
        this.showRightMaterial()
      }
      this.webcamStreamId = null;
    });

    this.startVideoStream = async (webcamStreamId) => {
      this.webcamStreamId = webcamStreamId;
      const state = this.getState();

      if (state.occupied) {
        if (state.me) {
          if (state.videoOn) {
            this.handleUserWantsCamera();
          } else {
            this.handleUserWantsAvatar();
          }
        } else {
          if (state.videoOn) {
            if (!document.getElementById(`remoteVideo-${webcamStreamId}`)) {
              return;
              // console.log(webcamStreamId, 'webcamStreamId')
              // console.log(document.getElementById(`remoteVideo-${webcamStreamId}`), 'webcamStreamId-div')
              // const videoElement = await waitForElement(`remoteVideo-${webcamStreamId}`);
              // this.videoElement = videoElement;
              // this.startVideo(videoElement);
              // this.fixRaportRatio();
            } else {
              const videoElement = document.getElementById(`remoteVideo-${webcamStreamId}`);
              this.videoElement = videoElement;
              this.startVideo(videoElement)
              this.fixRaportRatio();
            }
            this.videoElement && this.audioLevelsAnalyzer(this.videoElement.srcObject);
          } else {
            this.setAvatarImage(state.avatarImage)
          }
        }
      }
      else {
        this.standUp();
      }
    }
    this.setInitialMeshVisibility();
    ///new 
    return this;
  }

  fixRaportRatio(streamWidth, streamHeight) {
    if (!this.videoMaterial) {
      return;
    }
    if (this.webcamStreamId && savedStreamInfo[this.webcamStreamId]) {
      streamWidth = savedStreamInfo[this.webcamStreamId].streamWidth
      streamHeight = savedStreamInfo[this.webcamStreamId].streamHeight
    }
    // console.log('fixRaportRatio ', this.videoElement.videoWidth,this.videoElement.videoHeight);
    if (this.videoElement !== null && this.videoElement !== undefined) {
      if (streamWidth && streamHeight) {
        this.videoMaterial.uniforms.ratio.value = streamWidth / streamHeight;
        this.videoMaterial.uniforms.isPortrait.value = streamWidth < streamHeight;
      } else {
        setTimeout(() => { //hack unti figure out how to dispatch event after turnOnLocalCamera
          this.videoMaterial.uniforms.ratio.value = this.videoElement.videoWidth / this.videoElement.videoHeight;
          this.videoMaterial.uniforms.isPortrait.value = this.videoElement.videoWidth < this.videoElement.videoHeight;

        }, 2000);
      }
    } else {
      // this.forcedHCRaportRatio(640, 480);
    }
  }
  forcedHCRaportRatio(w, h) {
    this.videoMaterial.uniforms.ratio.value = w / h;
    this.videoMaterial.uniforms.isPortrait.value = w < h;
  }

  setMyMood() {
    // const mood = document.querySelector("#user_mood").classList[0].replace("mood_", "");
    // this.showOrUpdateMood(mood);
  }

  updateUserVideoState(state) {
    // console.log('updateUserVideoState ', state);
    if (this.videoElement !== null && this.videoElement !== undefined) {
      this.meshVideo.material = state ? this.videoMaterial : this.material;
      state ? $(this.videoElement).parent().removeClass('hidden') : $(this.videoElement).parent().addClass('hidden');
    }
  }

  useAvatarMaterial = (texture) => {
    // console.log('useAvatarMaterial');
    // this.mesh.material = this.material;
    // this.material.map = texture;
    // this.isVideoTexture = false;
    // this.setMyMood();
  }

  useVideoMaterial() {
    // if (this.startVideo(document.getElementById('myVideo'))) {
    //   this.isVideoTexture = true;
    // } else {
    //   this.model.alert('error', this.model.languageObject['error-turn-on-camera'].text);
    // }
    // this.setMyMood();
  }

  setInitialMeshVisibility() {
    this.mesh && (this.mesh.visible = true);
    this.moodMesh && (this.moodMesh.visible = true);
    this.meshVideo && (this.meshVideo.visible = true);
  }

  takeSeat() {
    this.setInitialMeshVisibility();
    $(`.indicator-${this.mesh.id}`).addClass('taken');
    this.requestAudioLevels = true;
    this.moodMesh.visible = true;
    this.videoElement && this.audioLevelsAnalyzer(this.videoElement.srcObject);
    return;
  }

  standUp() {
    if (this.model.editMode)
      return;
    this.mesh.visible = false;
    $(`.indicator-${this.mesh.id}`).removeClass('taken');
    this.hideUserOptions();
    this.userData = null;
    this.moodMesh.visible = false;
    this.requestAudioLevels = false;
    this.stopAudioLevelsAnalyzer();
    clearInterval(this.autoSendVolume)
    this.autoSendVolume = null;
    return;
  }

  occupySeat(userData) {
    if (!this.userInfo) {
      gsap.killTweensOf(this.mesh.rotation);
      gsap.from(this.mesh.rotation, {
        duration: (Math.random() * 2) + 1,
        y: "+=" + 4 * Math.PI, // This will add 180 degrees * 4, to the current rotation
        ease: "power3.out",
      });
    }
    this.userInfo = userData;
    this.userData = userData;
    this.emptySeat = false;
    this.takeSeat();
  }

  setBusyTexture = async (on1on1Call, userId) => {
    // // console.log('setBusy Texture' ,on1on1Call);
    // if (on1on1Call) {
    //   $('#remoteVideo_' + userId).addClass('hidden');
    //   $('#remoteVideo_' + userId).addClass('on-1on1-call');
    //   console.log($('#remoteVideo_' + userId));
    // } else {
    //   $('#remoteVideo_' + userId).removeClass('hidden');
    //   $('#remoteVideo_' + userId).removeClass('on-1on1-call');
    // }
    // this.busyMesh.visible = on1on1Call;
  }

  setAvatarImage(url, apply = true) {
    if (this.type === "screenStream" || !url)
      return;
    console.log('setAvatarImage');

    fetch(url, { method: 'HEAD' })
      .then(res => {
        if (res.ok) {
          //console.log('Image exists.');
          const tex = textureLoader.load(url);
          this.material.map = tex;
          if (apply) {
            // this.mesh.material = this.material;
          }
        } else {
          // console.log('Image does not exist.');
          //when from app.bagless.io or CORS problem
          this.material.map = defaultTexture;
          if (apply) {
            // this.mesh.material = this.material;
          }
        }
      }).catch(err => console.log('Error:', err));
  }

  startVideo(videoElement, userVideoOn = true, streamId, streamWidth, streamHeight, callShowMaterial = true) {
    if (this.webcamStreamId) {
      if (savedStreamInfo[this.webcamStreamId]) {
        streamWidth = savedStreamInfo[this.webcamStreamId].streamWidth
        streamHeight = savedStreamInfo[this.webcamStreamId].streamHeight
      }
    }
    if (userVideoOn) {
      this.videoElement = videoElement;
      console.log('startVideo!', videoElement.srcObject);
      if (streamWidth && streamHeight && streamWidth != 0 && streamHeight != 0) {
        // console.log('fixRaportRatio wh', streamWidth,streamHeight);
        this.fixRaportRatio(streamWidth, streamHeight);
      } else {
        if (streamHeight) {
          // console.log('data-width ',videoElement.getAttribute('stream-width'));
          this.fixRaportRatio(streamWidth, streamHeight);
        } else {
          this.fixRaportRatio();
        }
      };
      const { id } = videoElement;
      let material;
      if (!videoMaterials[id]) {
      }
      videoMaterials[id] = new VideoTexture(this.videoElement);
      this.takeSeat();
      this.videoMaterial.uniforms.tex.value = videoMaterials[id];
      this.leftImageMaterial.uniforms.tex.value = videoMaterials[id];
    }
    this.setInitialMeshVisibility();
    window.mesh = this;
    this.audioLevelsAnalyzer(videoElement.srcObject);
    return true;
  }

  isEmpty() {
    if (this.isSeatOccupiedByUser()) {
      return false
    }
    return true
    // return this.emptySeat;
  }

  isMine() {
    return this.iSitOnIt;
  }

  showUserOptions() {

    $(".cta-menu").removeClass("is-active");

    if (this.iSitOnIt) {
      $("#own-chair-menu").addClass("is-active");
    } else {
      $("#peer-chair-menu").addClass("is-active");
    }
    $("#peerIsFriend").hide();
    $("#peerAddAsFriend").hide();
    if (this.model.config.userId === this.userId) {
      return
    }
    if (this.userId && !this.model.friendsMap[this.userId]) {
      $("#peerIsFriend").hide();
      $("#peerAddAsFriend").show();
    } else {
      $("#peerIsFriend").show();
      $("#peerAddAsFriend").hide();
    }
  }

  hideUserOptions() {
    super.hideUserOptions();
    $("#own-chair-menu").removeClass("is-active");
    $("#peer-chair-menu").removeClass("is-active");
  }

  showInfo() {

    if (!this.userInfo)
      return;

    this.model.showUserInfo({ data: { ...this.userInfo, wpId: this.userInfo.hasProfile }, eventOrigin: '3Dobject' });
    this.hideUserOptions();
  }

  addAsFriend() {
    this.model.worldFetcher.addAsFriend(this.userId, (response) => {
      this.model.onFriendAddedSuccess(response);
    });
  }

  createPublicVideoElement(userData) {

    let streamId = userData.webcamStreamId;
    if (!streamId) {
      console.log('no stream id!');
      return;
    }
    let displayName = userData.userName;
    if ($(`#remoteVideo${streamId}`).length > 0) {
      // console.log('createPublicVideo Element return it exists!', displayName, streamId);
      // console.log('userData', userData);
      // this.occupySeat(userData);
      userData.userVideoOn ? this.startVideo(document.getElementById(`remoteVideo${streamId}`)) : this.setAvatarImage(userData.userAvatarUrl);
      return;
    }
    console.log('%c getRemoteVideoFromMedia Server', 'background: pink; font-size:1em');
    // let videoUrl = 'https://bagless-media-server.com:5443/WebRTCAppEE/play.html?name='+streamId;
    let userId = userData.userId;
    let avatar = userData.userAvatarUrl;
    let userVideoOn = userData.userVideoOn;
    let userScreenShareOn = userData.userScreenShareOn;

    console.log('_create video for ', displayName);
    var vidContainer = document.createElement('div');
    vidContainer.setAttribute('id', 'remoteVideo_' + userId);
    if (!userVideoOn) {
      vidContainer.setAttribute('class', 'video-wrapper hidden');
    } else {
      vidContainer.setAttribute('class', 'video-wrapper');
    }

    var videoElement = document.createElement('video');
    let videoId = `remoteVideo${streamId}`;
    videoElement.setAttribute('autoplay', true);
    videoElement.setAttribute('playsinline', true);
    videoElement.setAttribute('id', videoId);

    vidContainer.appendChild(videoElement);

    let peerImg = document.createElement('img');
    peerImg.setAttribute('src', avatar);
    peerImg.setAttribute('class', `avatar-img ${userId}`);
    vidContainer.appendChild(peerImg);

    const icon = document.createElement('span');
    icon.textContent = 'phone_in_talk'; //TODO
    icon.setAttribute('class', 'material-icons-outlined on-call-icon');
    vidContainer.appendChild(icon);
    // vidContainer.appendChild(this._generateLabelElement(displayName, userId));
    $('#localVideoContainer').append(vidContainer);

    this.videoElement = document.getElementById(`remoteVideo${userData.webcamStreamId}`);
    console.log('userData', userData);
    let unique_id = this.unique_id;
    // console.log('this.videoElement',this.videoElement);

    // this.model.dispatchEvent({ type: WEBRTC_EVENTS.GET_PUBLIC_STREAM, data: { streamId, videoId, userId, userVideoOn, userScreenShareOn, unique_id } });
    this.occupySeat(userData);

  }
  getState() {
    let user;
    const _occupiedBy = this.isSeatOccupiedByUser();
    if (!_occupiedBy) {
      this.state =
      {
        occupied: false,
        me: false,
        videoOn: false,
        avatarImage: null,
        webcamStreamId: null,
        isHalfMaterial: false,
        videosInfo: null,
      }
      return this.state;

    } if (_occupiedBy) {
      if (_occupiedBy === this.model.config.userId) {
        ///me
        this.state = {
          occupied: true,
          me: true,
          videoOn: this.model.userWantsCamera,
          avatarImage: this.model.config.userAvatarUrl,
          webcamStreamId: null,
          isHalfMaterial: false,
          videosInfo: this.model.videosInfo,
        }
      } else {
        const data = this.model.socket.getUsersObject()[_occupiedBy];
        user = data;
        const inRoom = webrtc.state !== states.NOT_IN_ROOM;
        const { userAvatarUrl, userVideoOn, webcamStreamId, screenShareStreamId, videosInfo } = data;
        let isHalfMaterial = false;
        if (webcamStreamId && screenShareStreamId) {
          isHalfMaterial = true;
        }
        this.state = {
          occupied: true,
          me: false,
          videoOn: inRoom && webcamStreamId && userVideoOn,
          avatarImage: userAvatarUrl,
          webcamStreamId: webcamStreamId,
          isHalfMaterial,
          videosInfo,
        }
      }
    }
    return this.state;
  }
  showRightMaterial() {
    this.mesh.material = emptyMaterial;
    const inRoom = webrtc.state !== states.NOT_IN_ROOM;
    if (this.state.occupied) {
      this.setInitialMeshVisibility();
      if (this.state.me) {
        if (this.model.userWantsCamera) {
          this.handleUserWantsCamera();
          // this.meshVideo.material = this.videoMaterial;
          this.mesh.material = this.videoMaterial;
          if (this.model.view.deviceSettingsMenu.selected.invertedCamera) {
            // this.invertCamera();
          } else {
            // this.normaliseCamera();
          }
          if (webrtc.videoMode === "screen+camera") {
            // this.mesh.material = this.leftImageMaterial;
            // if (this.state.videosInfo && this.videoElement) {
            //   const { camera: { height } } = this.state.videosInfo
            //   const aspectRatio = this.videoElement.videoHeight / height;
            //   this.videoMaterial.uniforms.ratio.value = aspectRatio / 2;
            // }
          }
        } else {
          this.handleUserWantsAvatar();
        }
        return;
      } if (inRoom) {
        if (this.state.videoOn) {
          this.meshVideo.material = this.videoMaterial;
          this.startVideoStream(this.state.webcamStreamId);
          if (this.state.isHalfMaterial) {
            this.startVideoStream(this.state.webcamStreamId);
            this.meshVideo.material = this.leftImageMaterial;
            // if (this.state.videosInfo && this.videoElement) {
            //   const { camera: { height } } = this.state.videosInfo
            //   const aspectRatio = this.videoElement.videoHeight / height;
            //   this.videoMaterial.uniforms.ratio.value = aspectRatio;
            // }
          } else {
            this.meshVideo.material = this.videoMaterial;
          }
        } else {
          this.state.userAvatarUrl && this.setAvatarImage(this.state.userAvatarUrl)
        }
      }
      else {
        this.setAvatarImage(this.state.userAvatarUrl)
      }
    } else {
      //not occupied
      this.mesh.visible = false;
    }
  }


  audioLevelsAnalyzer = (stream) => {
    if (!stream || this.autoSendVolume) {
      return
    }
    const audioContext = new AudioContext();
    const audioSource = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.4;
    audioSource.connect(analyser);
    const volumes = new Uint8Array(analyser.frequencyBinCount);

    this.requestAudioLevels = true;
    let firstSend = true;

    if (!this.autoSendVolume) {
      this.autoSendVolume = setInterval(() => {
        analyser.getByteFrequencyData(volumes);
        let volumeSum = 0;
        for (const volume of volumes) {
          volumeSum += volume;
        }
        this.averageVolume = Math.round(volumeSum / volumes.length);
        const scaleAmplitude = parseFloat(`1.${this.averageVolume / 20}`);
        this.fakeAudioLevelsAnimation(scaleAmplitude);
        this.moodMesh.scale.set(scaleAmplitude, scaleAmplitude, 1);

        this.iSitOnIt && this.model.socket.sendUserAudioLevelChanged(this.averageVolume);
      }, 100);
    }
  }
  stopAudioLevelsAnalyzer() {
    this.requestAudioLevels = false;
    this.averageVolume = 0;
    this.moodMesh.scale.set(1, 1, 1);
  }

  fakeAudioLevelsAnimation(amplitude) {
    gsap.to(this.moodMesh.scale, {
      duration: .5,
      x: amplitude,
      y: amplitude,
      ease: RoughEase.ease.config({ strength: 8, points: 5, template: Linear.easeNone, randomize: false }),
      onComplete: () => {
        gsap.to(this.moodMesh.scale, {
          duration: .25,
          x: 1,
          y: 1
        });
      }
    });
  }

  invertCamera() {
    if (this.inverted) {
      return;
    }
    this.mesh.material.uniforms.isMirror.value = true;
    // Important: Mark the texture for update
    gsap.killTweensOf(this.meshVideo.rotation);
    this.meshVideo.rotation.y = 0;
    gsap.to(this.meshVideo.rotation, {
      duration: 3,
      y: "+=" + Math.PI,
      ease: "power3.out",
    });
    this.inverted = true;
  }
  normaliseCamera() {
    if (!this.inverted)
      return;
    this.mesh.material.uniforms.isMirror.value = false;
    gsap.killTweensOf(this.meshVideo.rotation);
    this.meshVideo.rotation.y = Math.PI;
    gsap.to(this.meshVideo.rotation, {
      duration: 3,
      y: 0,
      ease: "power3.out",
    });
    this.inverted = false;
  }
}

export { VRChair };
