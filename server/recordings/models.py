from django.db import models
import uuid


class Recording(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    participant = models.ForeignKey('rooms.Participant')
    room = models.ForeignKey('rooms.Room', related_name='recordings')
    type = models.CharField(max_length=48)
    filesize = models.PositiveIntegerField()
    duration = models.PositiveIntegerField()
    created = models.DateTimeField(auto_now_add=True)
