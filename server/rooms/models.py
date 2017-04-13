import uuid
import json
import random

from django.db import models
from django.db.models.signals import post_save
from django.dispatch import receiver
from django.contrib.postgres.fields import JSONField
from django.conf import settings

from channels import Group, Channel
from model_utils import Choices

from fireside import redis_conn
from accounts.models import User


def generate_id():
    return ''.join(random.choice(
        'ABCDEFGHIJKLMNPQRSTUVWXYZ'
        'abcdefghijkmnopqrstuvwxyz'
        '0123456789'
    ) for x in range(6))


class RoomManager(models.Manager):
    def create_with_owner(self, owner):
        room = self.create(owner=owner)
        RoomMembership.objects.create(
            room=room,
            participant=owner,
            role='o',
            joined=room.created,
        )
        return room


class Room(models.Model):
    MESSAGE_TYPE_MAP = {
        's': 'signalling',
        'm': 'message',
        'l': 'leave',
        'j': 'join',
        'a': 'announce',
        'A': 'action',
        'e': 'event'
    }
    ACTION_TYPES = [
        'start_recording',
        'stop_recording',
        'kick'
    ]
    MESSAGE_TYPE_MAP_INVERSE = dict(
        (v, k) for k, v in MESSAGE_TYPE_MAP.items()
    )

    id = models.CharField(max_length=6, primary_key=True, default=generate_id)
    owner = models.ForeignKey('Participant', related_name='owned_rooms')
    members = models.ManyToManyField('Participant', through='RoomMembership', related_name='rooms')
    created = models.DateTimeField(auto_now_add=True)

    objects = RoomManager()

    def is_admin(self, participant):
        return participant == self.owner

    def is_valid_action(self, action_name):
        return action_name in self.ACTION_TYPES

    @classmethod
    def encode_message(cls, message):
        return json.dumps({
            't': cls.MESSAGE_TYPE_MAP_INVERSE[message['type']],
            'p': message['payload']
        })

    @classmethod
    def decode_message(cls, message):
        return cls.message(
            type=cls.MESSAGE_TYPE_MAP[message['t']],
            payload=message['p']
        )

    @classmethod
    def message(cls, type, payload):
        return {
            'type': type,
            'payload': payload
        }

    @property
    def group_name(self):
        return 'room.' + self.id

    @property
    def connected_memberships(self):
        participant_ids = redis_conn.hvals('rooms:{}:peers'.format(self.id))
        return self.memberships.filter(participant__in=participant_ids)

    def get_peer_id(self, participant):
        return redis_conn.get('rooms:{}:participants:{}:peer_id'.format(
            self.id,
            participant.id,
        ))

    def set_peer_id(self, participant):
        peer_id = uuid.uuid4().hex
        redis_conn.set('rooms:{}:participants:{}:peer_id'.format(
            self.id,
            participant.id,
        ), peer_id)
        return peer_id

    def connect_peer(self, peer_id, channel_name, participant):
        redis_conn.hset(
            'rooms:{}:peers'.format(self.id),
            peer_id,
            participant.id
        )
        self.set_peer_data(peer_id, 'channel', channel_name)

    def disconnect_peer(self, peer_id):
        redis_conn.hdel('rooms:{}:peers'.format(self.id), peer_id)
        redis_conn.delete('rooms:{}:peers:{}'.format(self.id, peer_id))

    def set_peer_data(self, peer_id, key, data):
        redis_conn.hset(
            'rooms:{}:peers:{}'.format(self.id, peer_id),
            key,
            json.dumps(data)
        )

    def channel_for_peer(self, peer_id):
        return Channel(self.get_peer_data(peer_id, 'channel'))

    def get_peer_data(self, peer_id, key):
        res = redis_conn.hget(
            'rooms:{}:peers:{}'.format(self.id, peer_id),
            key
        )
        if res is not None:
            return json.loads(res)
        else:
            return res

    def get_initial_data(self):
        from .serializers import InitialRoomDataSerializer
        return InitialRoomDataSerializer(self).data

    def send(self, message, to_peer=None, save=None):
        if to_peer is None:
            to = Group(self.group_name)
        else:
            to = self.channel_for_peer(to_peer)
        if save is None and to_peer is None:
            save = self.should_save_message(message)
        if save:
            self.add_message(**message)
        to.send({'text': self.encode_message(message)})

    def announce(self, peer_id, participant):
        from .serializers import PeerSerializer
        mem = self.memberships.get(participant=participant)
        self.send(self.message('announce', {
           'peer': PeerSerializer(mem).data
        }))

    def leave(self, peer_id):
        self.disconnect_peer(peer_id)
        self.send(self.message('leave', {
            'id': peer_id
        }))

    def join(self, participant, channel_name):
        if not self.members.filter(id=participant.id).exists():
            if participant == self.owner:
                role = RoomMembership.ROLE.owner
            else:
                role = RoomMembership.ROLE.guest
            self.memberships.create(
                participant=participant,
                role=role
            )

        peer_id = self.get_peer_id(participant)
        if peer_id is None:
            peer_id = self.set_peer_id(participant)

        self.connect_peer(peer_id, channel_name, participant)
        self.announce(peer_id, participant)
        return peer_id

    def add_message(self, type, payload, from_participant=None,
                    timestamp=None):
        self.messages.create(
            type=type,
            payload=payload,
            participant=from_participant,
            timestamp=timestamp,
        )

    def should_save_message(self, message):
        if message['type'] in ('leave', 'announce'):
            return True
        if message['type'] in ('join', 'signalling', 'action'):
            return False
        if message['type'] == 'event':
            event_type = message['payload']['type']
            return event_type not in (
                'recording_progress',
                'upload_progress',
                'meter_update',
            )


class RoomMembership(models.Model):
    ROLE = Choices(
        ('g', 'guest', 'Guest'),
        ('o', 'owner', 'Owner'),
    )
    participant = models.ForeignKey('Participant', related_name='memberships')
    room = models.ForeignKey('Room', related_name='memberships')
    name = models.CharField(max_length=64, blank=True, null=True)
    role = models.CharField(max_length=1, choices=ROLE, default=ROLE.guest)
    joined = models.DateTimeField(auto_now_add=True)

    @property
    def peer_id(self):
        return self.room.get_peer_id(self.participant)

    @property
    def current_recording_id(self):
        return (
            self.recordings.latest().values_list('id', flat=True)
            or [None]
        )[0]

    @property
    def current_recording(self):
        return self.recordings.latest()

    @property
    def recordings(self):
        return self.participant.recordings.all().filter(room=self.room)

    def get_display_name(self):
        return self.name if self.name is not None else self.participant.name


class Message(models.Model):
    room = models.ForeignKey('Room', related_name='messages')
    participant = models.ForeignKey('Participant', blank=True, null=True)
    type = models.CharField(max_length=16)
    payload = JSONField()
    timestamp = models.DateTimeField(auto_now_add=True)


class Participant(models.Model):
    user = models.OneToOneField('accounts.User', blank=True, null=True,
                                related_name='participant')
    session_key = models.CharField(max_length=32, blank=True, null=True)
    name = models.CharField(max_length=64, blank=True, null=True)


@receiver(post_save, sender=User)
def create_participant_for_user(sender, instance, created, **kwargs):
    if created:
        Participant.objects.create(
            user=instance,
            name=instance.get_short_name()
        )
    else:
        instance.participant.name = instance.get_short_name()
        instance.participant.save()


if settings.DEBUG:
    redis_conn.flushdb()