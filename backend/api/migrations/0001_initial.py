from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
    ]

    operations = [
        migrations.CreateModel(
            name='MailboxState',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('user_key', models.CharField(max_length=64, unique=True)),
                ('uid_validity', models.CharField(blank=True, default='', max_length=32)),
                ('window_days', models.PositiveIntegerField(default=15)),
                ('last_sync_at', models.DateTimeField(blank=True, null=True)),
            ],
        ),
        migrations.CreateModel(
            name='DayCoverage',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('user_key', models.CharField(db_index=True, max_length=64)),
                ('day', models.DateField()),
                ('message_count', models.PositiveIntegerField(default=0)),
                ('fetched_at', models.DateTimeField(auto_now=True)),
            ],
            options={
                'constraints': [models.UniqueConstraint(fields=('user_key', 'day'), name='unique_coverage_user_day')],
            },
        ),
        migrations.CreateModel(
            name='EmailMessage',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('user_key', models.CharField(db_index=True, max_length=64)),
                ('imap_uid', models.PositiveIntegerField()),
                ('message_id', models.CharField(blank=True, db_index=True, default='', max_length=255)),
                ('received_at', models.DateTimeField(db_index=True)),
                ('received_label', models.CharField(blank=True, default='', max_length=64)),
                ('sender_name', models.CharField(blank=True, default='', max_length=255)),
                ('sender_email', models.CharField(blank=True, default='', max_length=255)),
                ('subject', models.CharField(blank=True, default='', max_length=1000)),
                ('body', models.TextField(blank=True, default='')),
                ('snippet', models.CharField(blank=True, default='', max_length=400)),
                ('excerpt', models.CharField(blank=True, default='', max_length=1000)),
                ('is_read', models.BooleanField(default=True)),
                ('source', models.CharField(blank=True, default='internal', max_length=16)),
                ('updated_at', models.DateTimeField(auto_now=True, db_index=True)),
                ('fetched_at', models.DateTimeField(auto_now_add=True)),
            ],
            options={
                'ordering': ['-received_at'],
                'indexes': [models.Index(fields=['user_key', 'received_at'], name='api_email_user_recv')],
                'constraints': [models.UniqueConstraint(fields=('user_key', 'imap_uid'), name='unique_user_imap_uid')],
            },
        ),
    ]
